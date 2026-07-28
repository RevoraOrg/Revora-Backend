/**
 * Resumable investor-statement PDF batch worker (Issue #540).
 *
 * Mirrors OutboxDispatcher polling + SKIP LOCKED claims, with:
 * - Postgres checkpoints (job status / storage_key / checksum)
 * - Stale processing reclaim after crash
 * - Worker pool (bounded concurrency) for shard throughput
 * - Throughput metrics (jobs/sec gauge + completed counter)
 */

import { MetricsCollector } from '../lib/metrics';
import {
  PdfRenderJobRepository,
  PdfRenderJobRow,
  PdfRenderBatchRow,
} from '../db/repositories/pdfRenderJobRepository';
import { StatementRenderFn, StatementRenderOptions } from './statementPdfService';

export const METRIC_PDF_JOBS_ENQUEUED = 'statement_pdf_jobs_enqueued_total';
export const METRIC_PDF_JOBS_COMPLETED = 'statement_pdf_jobs_completed_total';
export const METRIC_PDF_JOBS_FAILED = 'statement_pdf_jobs_failed_total';
export const METRIC_PDF_RENDER_DURATION = 'statement_pdf_render_duration_ms';
export const METRIC_PDF_THROUGHPUT = 'statement_pdf_throughput_jobs_per_sec';
export const METRIC_PDF_BACKLOG = 'statement_pdf_batch_backlog';

export interface StatementPdfBatchWorkerOptions {
  /** Jobs claimed per drain cycle. Default: 50. */
  batchSize?: number;
  /** Poll interval ms. Default: 5000. */
  intervalMs?: number;
  /** Concurrent renders inside a drain cycle. Default: 4. */
  concurrency?: number;
  /** Max attempts before dead-letter. Default: 5. */
  maxAttempts?: number;
  /** Base retry backoff ms. Default: 1000. */
  retryBaseMs?: number;
  /** Reclaim processing jobs older than this. Default: 15 minutes. */
  staleAfterMs?: number;
  /** Optional render configuration (watermark suppression, treasury keys, etc.) */
  renderOptions?: StatementRenderOptions;
}

function shortLabel(id: string): string {
  return id.split('-')[0] ?? id.slice(0, 8);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

export class StatementPdfBatchWorker {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly staleAfterMs: number;
  private readonly renderOptions?: StatementRenderOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private completedWindow: Array<{ at: number }> = [];

  constructor(
    private readonly jobRepo: PdfRenderJobRepository,
    private readonly render: StatementRenderFn,
    private readonly metrics: MetricsCollector,
    options: StatementPdfBatchWorkerOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.intervalMs = options.intervalMs ?? 5000;
    this.concurrency = options.concurrency ?? 4;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.staleAfterMs = options.staleAfterMs ?? 15 * 60 * 1000;
    this.renderOptions = options.renderOptions;
  }

  /** Start the polling loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Enqueue a period's investors into a new batch.
   * Checkpoints are rows in pdf_render_jobs — nothing is held only in memory.
   */
  async enqueuePeriod(
    periodId: string,
    investorIds: string[],
  ): Promise<{ batch: PdfRenderBatchRow; inserted: number }> {
    const result = await this.jobRepo.enqueueBatch(periodId, investorIds);
    this.metrics.incrementCounter(
      METRIC_PDF_JOBS_ENQUEUED,
      { period: periodId.slice(0, 16) },
      result.inserted,
      'Investor statement PDF jobs enqueued',
    );
    this.metrics.setGauge(
      METRIC_PDF_BACKLOG,
      result.inserted,
      { batch: shortLabel(result.batch.id) },
      'Pending+processing statement PDF jobs',
    );
    return result;
  }

  /** Single claim/render cycle. Returns jobs processed. */
  async drainOnce(): Promise<number> {
    const jobs = await this.jobRepo.claimJobs(this.batchSize, this.staleAfterMs);
    if (jobs.length === 0) {
      await this.refreshThroughput(0);
      return 0;
    }

    await mapPool(jobs, this.concurrency, (job) => this.processJob(job));
    await this.refreshThroughput(jobs.length);

    const backlog = await this.jobRepo.countPending();
    this.metrics.setGauge(METRIC_PDF_BACKLOG, backlog, { batch: 'all' });

    return jobs.length;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.drainOnce();
      } catch {
        // row-level errors handled in processJob
      }
      this.scheduleNext();
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  private async processJob(job: PdfRenderJobRow): Promise<void> {
    const started = Date.now();
    try {
      const result = await this.render(job, this.renderOptions);
      await this.jobRepo.markCompleted(job.id, result.storageKey, result.checksum);
      this.metrics.incrementCounter(METRIC_PDF_JOBS_COMPLETED, {
        period: job.period_id.slice(0, 16),
      });
      this.metrics.recordHistogram(
        METRIC_PDF_RENDER_DURATION,
        Date.now() - started,
        { status: 'ok' },
      );
      this.completedWindow.push({ at: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'render failed';
      this.metrics.recordHistogram(
        METRIC_PDF_RENDER_DURATION,
        Date.now() - started,
        { status: 'error' },
      );

      if (job.attempts >= this.maxAttempts) {
        await this.jobRepo.markFailed(job.id, message);
        this.metrics.incrementCounter(METRIC_PDF_JOBS_FAILED, {
          period: job.period_id.slice(0, 16),
        });
      } else {
        const delayMs = this.retryBaseMs * Math.pow(2, Math.max(0, job.attempts - 1));
        const retryAfter = new Date(Date.now() + delayMs);
        await this.jobRepo.markFailed(job.id, message, retryAfter);
      }
    }
  }

  /** Sliding 60s throughput gauge (jobs completed / second). */
  private async refreshThroughput(justProcessed: number): Promise<void> {
    const now = Date.now();
    this.completedWindow = this.completedWindow.filter((e) => now - e.at <= 60_000);
    const rate = this.completedWindow.length / 60;
    this.metrics.setGauge(
      METRIC_PDF_THROUGHPUT,
      Number(rate.toFixed(4)),
      { window: '60s' },
      'Investor statement PDF render throughput',
    );
    void justProcessed;
  }
}

export function createStatementPdfBatchWorker(
  jobRepo: PdfRenderJobRepository,
  render: StatementRenderFn,
  metrics: MetricsCollector,
  options?: StatementPdfBatchWorkerOptions,
): StatementPdfBatchWorker {
  return new StatementPdfBatchWorker(jobRepo, render, metrics, options);
}
