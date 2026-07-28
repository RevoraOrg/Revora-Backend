/**
 * Tests for resumable investor-statement PDF batch pipeline (#540):
 *  1. Enqueue creates batch + jobs; duplicate investors collapse
 *  2. Successful drain marks completed with storage_key + checksum
 *  3. Transient failure schedules retry (pending + retryAfter)
 *  4. Exhausted attempts dead-letters
 *  5. Crash mid-batch: stale reclaim + same storage_key (no duplicate outputs)
 *  6. Deterministic render bytes / checksum across retries
 *  7. Throughput metric emitted
 *  8. start/stop polling loop
 */

import { MetricsCollector } from '../lib/metrics';
import {
  PdfRenderJobRepository,
  PdfRenderJobRow,
  PdfRenderBatchRow,
  buildStatementStorageKey,
  checksumPayload,
} from '../db/repositories/pdfRenderJobRepository';
import {
  StatementPdfBatchWorker,
  METRIC_PDF_JOBS_COMPLETED,
  METRIC_PDF_JOBS_FAILED,
  METRIC_PDF_THROUGHPUT,
  METRIC_PDF_JOBS_ENQUEUED,
  METRIC_PDF_BACKLOG,
  createStatementPdfBatchWorker,
} from './statementPdfBatchWorker';
import {
  InMemoryStatementPdfStorage,
  makeStatementRenderFn,
  renderStatementPdfBytes,
} from './statementPdfService';

function makeBatch(overrides: Partial<PdfRenderBatchRow> = {}): PdfRenderBatchRow {
  return {
    id: 'batch-1',
    period_id: '2026-06',
    total_jobs: 2,
    completed_jobs: 0,
    failed_jobs: 0,
    status: 'running',
    started_at: new Date(),
    completed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<PdfRenderJobRow> = {}): PdfRenderJobRow {
  const investor_id = overrides.investor_id ?? 'inv-1';
  const period_id = overrides.period_id ?? '2026-06';
  return {
    id: 'job-1',
    batch_id: 'batch-1',
    investor_id,
    period_id,
    status: 'processing',
    attempts: 1,
    available_at: new Date(),
    claimed_at: new Date(),
    storage_key: buildStatementStorageKey(period_id, investor_id),
    checksum: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeRepo(jobs: PdfRenderJobRow[] = []): jest.Mocked<PdfRenderJobRepository> {
  return {
    enqueueBatch: jest.fn().mockResolvedValue({ batch: makeBatch(), inserted: jobs.length || 1 }),
    claimJobs: jest.fn().mockResolvedValue(jobs),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    getBatch: jest.fn().mockResolvedValue(makeBatch()),
    countPending: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<PdfRenderJobRepository>;
}

beforeEach(() => jest.clearAllMocks());

describe('statementPdfService', () => {
  it('renders deterministic bytes and overwrites the same storage key', async () => {
    const storage = new InMemoryStatementPdfStorage();
    const render = makeStatementRenderFn(storage);
    const job = makeJob();

    const first = await render(job);
    const second = await render(job);

    expect(first.storageKey).toBe(second.storageKey);
    expect(first.checksum).toBe(second.checksum);
    expect(storage.size()).toBe(1);
    expect(checksumPayload(first.bytes)).toBe(first.checksum);
    expect(renderStatementPdfBytes(job).equals(first.bytes)).toBe(true);
  });


  it('InMemoryStatementPdfStorage supports get/clear/size', async () => {
    const storage = new InMemoryStatementPdfStorage();
    expect(await storage.getObject('missing')).toBeNull();
    await storage.putObject('k', Buffer.from('x'));
    expect(storage.size()).toBe(1);
    storage.clear();
    expect(storage.size()).toBe(0);
  });

  it('makeStatementRenderFn uses built storage key when job.storage_key is null', async () => {
    const storage = new InMemoryStatementPdfStorage();
    const render = makeStatementRenderFn(storage);
    const job = makeJob({ storage_key: null });
    const result = await render(job);
    expect(result.storageKey).toBe(buildStatementStorageKey(job.period_id, job.investor_id));
  });


  it('throws when post-render checksum verification fails', async () => {
    const storage = new InMemoryStatementPdfStorage();
    jest
      .spyOn(require('../db/repositories/pdfRenderJobRepository'), 'checksumPayload')
      .mockReturnValue('tampered');
    const render = makeStatementRenderFn(storage);
    await expect(render(makeJob())).rejects.toThrow('statement PDF checksum mismatch');
    jest.restoreAllMocks();
  });

  it('buildStatementStorageKey is stable per investor+period', () => {
    expect(buildStatementStorageKey('2026-06', 'inv-1')).toBe(
      'statements/2026-06/inv-1.pdf',
    );
  });
});

describe('StatementPdfBatchWorker', () => {
  it('enqueues a period and records enqueued metric', async () => {

    const repo = makeRepo();
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const spy = jest.spyOn(metrics, 'incrementCounter');
    const worker = new StatementPdfBatchWorker(repo, jest.fn(), metrics);

    const result = await worker.enqueuePeriod('2026-06', ['inv-1', 'inv-2', 'inv-1']);
    expect(repo.enqueueBatch).toHaveBeenCalledWith('2026-06', ['inv-1', 'inv-2', 'inv-1']);
    expect(result.batch.id).toBe('batch-1');
    expect(spy).toHaveBeenCalledWith(
      METRIC_PDF_JOBS_ENQUEUED,
      expect.any(Object),
      expect.any(Number),
      expect.any(String),
    );
  });

  it('marks completed on successful render and emits throughput', async () => {
    const job = makeJob();
    const repo = makeRepo([job]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const gaugeSpy = jest.spyOn(metrics, 'setGauge');
    const counterSpy = jest.spyOn(metrics, 'incrementCounter');
    const storage = new InMemoryStatementPdfStorage();
    const worker = new StatementPdfBatchWorker(
      repo,
      makeStatementRenderFn(storage),
      metrics,
      { concurrency: 2 },
    );

    const processed = await worker.drainOnce();
    expect(processed).toBe(1);
    expect(repo.markCompleted).toHaveBeenCalledWith(
      job.id,
      job.storage_key,
      expect.any(String),
    );
    expect(counterSpy).toHaveBeenCalledWith(
      METRIC_PDF_JOBS_COMPLETED,
      expect.any(Object),
    );
    expect(gaugeSpy).toHaveBeenCalledWith(
      METRIC_PDF_THROUGHPUT,
      expect.any(Number),
      expect.any(Object),
      expect.any(String),
    );
    expect(storage.size()).toBe(1);
  });

  it('schedules retry on transient failure before maxAttempts', async () => {
    const job = makeJob({ attempts: 1 });
    const repo = makeRepo([job]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(
      repo,
      jest.fn().mockRejectedValue(new Error('rpc timeout')),
      metrics,
      { maxAttempts: 5, retryBaseMs: 100 },
    );

    await worker.drainOnce();
    expect(repo.markFailed).toHaveBeenCalledWith(
      job.id,
      'rpc timeout',
      expect.any(Date),
    );
    expect(repo.markCompleted).not.toHaveBeenCalled();
  });

  it('dead-letters after maxAttempts', async () => {
    const job = makeJob({ attempts: 5 });
    const repo = makeRepo([job]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const counterSpy = jest.spyOn(metrics, 'incrementCounter');
    const worker = new StatementPdfBatchWorker(
      repo,
      jest.fn().mockRejectedValue(new Error('permanent')),
      metrics,
      { maxAttempts: 5 },
    );

    await worker.drainOnce();
    expect(repo.markFailed).toHaveBeenCalledWith(job.id, 'permanent');
    expect(counterSpy).toHaveBeenCalledWith(
      METRIC_PDF_JOBS_FAILED,
      expect.any(Object),
    );
  });

  it('crash mid-batch resume reuses the same storage key (no duplicate outputs)', async () => {
    const storage = new InMemoryStatementPdfStorage();
    const render = makeStatementRenderFn(storage);
    const job = makeJob({ investor_id: 'inv-42', period_id: '2026-06' });

    // First attempt "crashes" after writing object but before markCompleted
    const first = await render(job);
    expect(storage.size()).toBe(1);

    // Worker resumes: claim returns the same job (stale reclaim), completes
    const repo = makeRepo([{ ...job, attempts: 2 }]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(repo, render, metrics);
    await worker.drainOnce();

    expect(storage.size()).toBe(1);
    expect(repo.markCompleted).toHaveBeenCalledWith(
      job.id,
      first.storageKey,
      first.checksum,
    );
    const stored = await storage.getObject(first.storageKey);
    expect(stored && checksumPayload(stored)).toBe(first.checksum);
  });

  it('processes a claimed shard concurrently without dropping jobs', async () => {
    const jobs = [
      makeJob({ id: 'j1', investor_id: 'inv-1' }),
      makeJob({ id: 'j2', investor_id: 'inv-2' }),
      makeJob({ id: 'j3', investor_id: 'inv-3' }),
    ];
    const repo = makeRepo(jobs);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const storage = new InMemoryStatementPdfStorage();
    const worker = new StatementPdfBatchWorker(
      repo,
      makeStatementRenderFn(storage),
      metrics,
      { concurrency: 3 },
    );

    const n = await worker.drainOnce();
    expect(n).toBe(3);
    expect(repo.markCompleted).toHaveBeenCalledTimes(3);
    expect(storage.size()).toBe(3);
  });

  it('returns 0 and still refreshes throughput when queue is empty', async () => {
    const repo = makeRepo([]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const gaugeSpy = jest.spyOn(metrics, 'setGauge');
    const worker = new StatementPdfBatchWorker(repo, jest.fn(), metrics);
    expect(await worker.drainOnce()).toBe(0);
    expect(gaugeSpy).toHaveBeenCalledWith(
      METRIC_PDF_THROUGHPUT,
      expect.any(Number),
      expect.any(Object),
      expect.any(String),
    );
  });


  it('records backlog gauge after processing jobs', async () => {
    const job = makeJob();
    const repo = makeRepo([job]);
    repo.countPending.mockResolvedValue(7);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const gaugeSpy = jest.spyOn(metrics, 'setGauge');
    const worker = new StatementPdfBatchWorker(
      repo,
      makeStatementRenderFn(new InMemoryStatementPdfStorage()),
      metrics,
    );
    await worker.drainOnce();
    expect(gaugeSpy).toHaveBeenCalledWith(METRIC_PDF_BACKLOG, 7, { batch: 'all' });
  });

  it('retries use generic message for non-Error throws', async () => {
    const job = makeJob({ attempts: 1 });
    const repo = makeRepo([job]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(
      repo,
      jest.fn().mockRejectedValue('bad'),
      metrics,
      { maxAttempts: 5, retryBaseMs: 50 },
    );
    await worker.drainOnce();
    expect(repo.markFailed).toHaveBeenCalledWith(job.id, 'render failed', expect.any(Date));
  });

  it('scheduleNext survives drainOnce rejection', async () => {
    jest.useFakeTimers();
    const repo = makeRepo([]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(repo, jest.fn(), metrics, { intervalMs: 1000 });
    jest.spyOn(worker, 'drainOnce').mockRejectedValue(new Error('poll failed'));
    worker.start();
    await jest.advanceTimersByTimeAsync(1000);
    worker.stop();
    jest.useRealTimers();
  });

  it('createStatementPdfBatchWorker returns a worker instance', () => {
    const repo = makeRepo();
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = createStatementPdfBatchWorker(repo, jest.fn(), metrics);
    expect(worker).toBeInstanceOf(StatementPdfBatchWorker);
  });



  it('enqueuePeriod shortens dashed batch ids for backlog label', async () => {
    const repo = makeRepo();
    repo.enqueueBatch.mockResolvedValueOnce({
      batch: makeBatch({ id: 'part1-part2' }),
      inserted: 2,
    });
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const gaugeSpy = jest.spyOn(metrics, 'setGauge');
    const worker = new StatementPdfBatchWorker(repo, jest.fn(), metrics);
    await worker.enqueuePeriod('2026-06', ['inv-1', 'inv-2']);
    expect(gaugeSpy).toHaveBeenCalledWith(
      METRIC_PDF_BACKLOG,
      2,
      { batch: 'part1' },
      expect.any(String),
    );
  });

  it('start/stop controls the polling loop', () => {
    jest.useFakeTimers();
    const repo = makeRepo([]);
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(repo, jest.fn(), metrics, {
      intervalMs: 1000,
    });
    const drain = jest.spyOn(worker, 'drainOnce').mockResolvedValue(0);

    worker.start();
    worker.start(); // idempotent
    jest.advanceTimersByTime(1000);
    expect(drain).toHaveBeenCalled();
    worker.stop();
    jest.advanceTimersByTime(5000);
    worker.stop();
    jest.useRealTimers();
  });

  it('passes renderOptions to the render function during drainOnce', async () => {
    const job = makeJob();
    const repo = makeRepo([job]);
    const renderFn = jest.fn().mockResolvedValue({
      storageKey: 'k',
      checksum: 'c',
      bytes: Buffer.from('pdf'),
      watermarkSuppressed: true,
      ledgerRevisionHash: 'rev-1',
    });
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const renderOptions = { ledgerRevisionHash: 'rev-1' };
    const worker = new StatementPdfBatchWorker(repo, renderFn, metrics, { renderOptions });

    await worker.drainOnce();
    expect(renderFn).toHaveBeenCalledWith(job, renderOptions);
  });

  it('runs mapPool bounded worker pool during drainOnce with multiple jobs', async () => {
    const jobs = [makeJob({ id: 'j1' }), makeJob({ id: 'j2' }), makeJob({ id: 'j3' })];
    const repo = makeRepo(jobs);
    const renderFn = jest.fn().mockResolvedValue({
      storageKey: 'k',
      checksum: 'c',
      bytes: Buffer.from('pdf'),
      watermarkSuppressed: false,
      ledgerRevisionHash: 'rev-1',
    });
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const worker = new StatementPdfBatchWorker(repo, renderFn, metrics, { concurrency: 2 });
    const processed = await worker.drainOnce();
    expect(processed).toBe(3);
    expect(renderFn).toHaveBeenCalledTimes(3);
  });
});

describe('PdfRenderJobRepository helpers', () => {
  it('exports deterministic storage key helper', () => {
    expect(buildStatementStorageKey('p', 'i')).toBe('statements/p/i.pdf');
  });
});
