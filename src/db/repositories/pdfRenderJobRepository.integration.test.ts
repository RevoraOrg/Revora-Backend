/**
 * Real-Postgres integration coverage for the resumable investor-statement PDF
 * batch pipeline (closes #728).
 *
 * The unit suite in `statementPdfBatchWorker.test.ts` exercises the worker
 * against in-memory fakes, which is the right trade for logic coverage but
 * cannot prove the two guarantees #728 actually asks for:
 *
 *  1. "Checkpoint stored in Postgres, not memory" — durability has to be shown
 *     across repository instances, not just across fake objects.
 *  2. "Crash mid-batch resumes without duplicating outputs" — depends on
 *     `FOR UPDATE SKIP LOCKED` and a real clock, neither of which an in-memory
 *     double can model.
 *
 * These tests run against a real PostgreSQL container using the schema from
 * `db/migrations/037_create_pdf_render_jobs.sql`.
 *
 * Requires a container runtime. If none is available the suite is skipped
 * rather than failed, so a Docker-less developer machine stays green while CI
 * (which has Docker) enforces the contract.
 */

import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import * as fs from 'fs';
import * as path from 'path';
import {
  PdfRenderJobRepository,
  buildStatementStorageKey,
  checksumPayload,
} from './pdfRenderJobRepository';

// ── Container runtime detection ───────────────────────────────────────────────

function containerRuntimeAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const RUNTIME_AVAILABLE = containerRuntimeAvailable();

if (!RUNTIME_AVAILABLE) {
  // Loud, not silent: a reviewer should know this suite did not run.
  console.warn(
    '[pdfRenderJobRepository.integration] No Docker runtime detected — skipping ' +
      'real-Postgres assertions. Run with Docker available to enforce them.',
  );
}

const describeWithPostgres = RUNTIME_AVAILABLE ? describe : describe.skip;

/**
 * Pinned so a bad registry pull fails fast and locally rather than at runtime
 * on an unrelated day.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine';

// ── Suite ─────────────────────────────────────────────────────────────────────

describeWithPostgres('PdfRenderJobRepository (real Postgres)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let repo: PdfRenderJobRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    const migration = fs.readFileSync(
      path.join(__dirname, '../migrations/037_create_pdf_render_jobs.sql'),
      'utf-8',
    );
    await pool.query(migration);

    repo = new PdfRenderJobRepository(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE pdf_render_jobs, pdf_render_batches CASCADE');
  });

  // ── Requirement 1: checkpoint lives in Postgres, not memory ─────────────────

  it('should persist the checkpoint so a fresh repository instance reads it back', async () => {
    const { batch } = await repo.enqueueBatch('2026-06', ['inv-a', 'inv-b']);
    const jobs = await repo.claimJobs(2, 60_000);
    const job = jobs[0];

    await repo.markCompleted(job.id, job.storage_key!, checksumPayload('bytes-a'));

    // A brand-new repository over the same pool stands in for a process restart:
    // nothing is carried in memory, so the checkpoint must come from the table.
    const afterRestart = new PdfRenderJobRepository(pool);
    const persisted = await afterRestart.findCompletedByInvestorAndPeriod(
      job.investor_id,
      '2026-06',
    );

    expect(persisted).not.toBeNull();
    expect(persisted!.checksum).toBe(checksumPayload('bytes-a'));
    expect(persisted!.storage_key).toBe(buildStatementStorageKey('2026-06', job.investor_id));

    const reloaded = await afterRestart.getBatch(batch.id);
    expect(reloaded!.completed_jobs).toBe(1);
  });

  it('should keep the checkpoint in the table rather than in process state', async () => {
    const { batch } = await repo.enqueueBatch('2026-06', ['inv-a']);
    const [job] = await repo.claimJobs(1, 60_000);
    await repo.markCompleted(job.id, job.storage_key!, 'sum-a');

    // Read the raw row, bypassing the repository entirely.
    const raw = await pool.query('SELECT status, storage_key, checksum FROM pdf_render_jobs WHERE id = $1', [
      job.id,
    ]);

    expect(raw.rows[0].status).toBe('completed');
    expect(raw.rows[0].checksum).toBe('sum-a');
    expect((await repo.getBatch(batch.id))!.completed_jobs).toBe(1);
  });

  // ── Requirement 2: SKIP LOCKED never double-claims ─────────────────────────

  it('should never hand the same job to two concurrent workers', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a', 'inv-b', 'inv-c', 'inv-d']);

    // Two independent repositories racing for the same pending rows, the way two
    // worker processes would.
    const workerA = new PdfRenderJobRepository(pool);
    const workerB = new PdfRenderJobRepository(pool);
    const [claimedA, claimedB] = await Promise.all([
      workerA.claimJobs(4, 60_000),
      workerB.claimJobs(4, 60_000),
    ]);

    const idsA = claimedA.map((j) => j.id);
    const idsB = claimedB.map((j) => j.id);
    const overlap = idsA.filter((id) => idsB.includes(id));

    expect(overlap).toEqual([]);
    // Every job is claimed exactly once across the pair of workers.
    expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);
    expect(idsA.length + idsB.length).toBeGreaterThan(0);
  });

  it('should increment attempts exactly once per claim', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a']);
    const [claimed] = await repo.claimJobs(1, 60_000);

    expect(claimed.attempts).toBe(1);

    const row = await pool.query('SELECT attempts, status FROM pdf_render_jobs WHERE id = $1', [
      claimed.id,
    ]);
    expect(row.rows[0].attempts).toBe(1);
    expect(row.rows[0].status).toBe('processing');
  });

  // ── Requirement 3: crash mid-batch resumes without duplicating output ──────

  it('should reclaim a stale processing job after a crash and keep the same storage key', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a']);
    const [first] = await repo.claimJobs(1, 60_000);

    // Simulate the worker dying: status stays 'processing' and claimed_at ages.
    await pool.query(
      "UPDATE pdf_render_jobs SET claimed_at = NOW() - INTERVAL '10 minutes' WHERE id = $1",
      [first.id],
    );

    // A restarted worker with a 60s staleness window must pick the job back up.
    const afterRestart = new PdfRenderJobRepository(pool);
    const [reclaimed] = await afterRestart.claimJobs(1, 60_000);

    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.attempts).toBe(2);
    // The durable-output guarantee: the artifact identity is unchanged, so a
    // resume overwrites in place instead of creating a second object.
    expect(reclaimed.storage_key).toBe(first.storage_key);
  });

  it('should not reclaim a job that is still being processed', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a']);
    await repo.claimJobs(1, 60_000);

    // claimed_at is NOW(), so a long staleness window must not steal the job
    // from a live worker.
    const live = await repo.claimJobs(1, 3_600_000);
    expect(live).toEqual([]);
  });

  it('should produce a deterministic storage key per investor and period', async () => {
    const first = await repo.enqueueBatch('2026-06', ['inv-a']);
    const second = await repo.enqueueBatch('2026-06', ['inv-a']);

    const keyA = buildStatementStorageKey('2026-06', 'inv-a');
    expect(keyA).toBe('statements/2026-06/inv-a.pdf');

    // Different batch rows, same artifact identity.
    expect(first.batch.id).not.toBe(second.batch.id);
    const rows = await pool.query('SELECT DISTINCT storage_key FROM pdf_render_jobs');
    expect(rows.rows.map((r) => r.storage_key)).toEqual([keyA]);
  });

  it('should collapse duplicate investors within a single batch', async () => {
    const { batch, inserted } = await repo.enqueueBatch('2026-06', ['inv-a', 'inv-a', 'inv-b']);

    expect(inserted).toBe(2);
    expect(batch.total_jobs).toBe(2);
    expect(await repo.countPending(batch.id)).toBe(2);
  });

  // ── Retry / dead-letter resume paths ───────────────────────────────────────

  it('should return a retried job to pending and make it claimable once available', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a']);
    const [job] = await repo.claimJobs(1, 60_000);

    const retryAt = new Date(Date.now() + 60_000);
    await repo.markFailed(job.id, 'transient renderer error', retryAt);

    // Not claimable before available_at.
    expect(await repo.claimJobs(1, 60_000)).toEqual([]);

    await pool.query('UPDATE pdf_render_jobs SET available_at = NOW() - INTERVAL \'1 second\'');
    const [resumed] = await repo.claimJobs(1, 60_000);

    expect(resumed.id).toBe(job.id);
    expect(resumed.status).toBe('processing');
  });

  it('should dead-letter a job when no retry is scheduled', async () => {
    const { batch } = await repo.enqueueBatch('2026-06', ['inv-a']);
    const [job] = await repo.claimJobs(1, 60_000);

    await repo.markFailed(job.id, 'permanent failure');

    const row = await pool.query('SELECT status, error, claimed_at FROM pdf_render_jobs WHERE id = $1', [
      job.id,
    ]);
    expect(row.rows[0].status).toBe('failed');
    expect(row.rows[0].error).toBe('permanent failure');
    expect(row.rows[0].claimed_at).toBeNull();

    // Dead-lettered rows are never handed back out.
    expect(await repo.claimJobs(1, 60_000)).toEqual([]);
    expect(await repo.countPending(batch.id)).toBe(0);
  });

  // ── Availability gating and batch rollup ───────────────────────────────────

  it('should not claim a job whose available_at is in the future', async () => {
    await repo.enqueueBatch('2026-06', ['inv-a']);
    await pool.query(
      "UPDATE pdf_render_jobs SET available_at = NOW() + INTERVAL '1 hour'",
    );

    expect(await repo.claimJobs(10, 60_000)).toEqual([]);
  });

  it('should complete the batch only once every job settles', async () => {
    const { batch } = await repo.enqueueBatch('2026-06', ['inv-a', 'inv-b']);
    const jobs = await repo.claimJobs(2, 60_000);

    await repo.markCompleted(jobs[0].id, jobs[0].storage_key!, 'sum-a');
    let state = await repo.getBatch(batch.id);
    expect(state!.completed_jobs).toBe(1);
    expect(state!.status).toBe('running');
    expect(state!.completed_at).toBeNull();

    await repo.markCompleted(jobs[1].id, jobs[1].storage_key!, 'sum-b');
    state = await repo.getBatch(batch.id);

    expect(state!.completed_jobs).toBe(2);
    expect(state!.status).toBe('completed');
    expect(state!.completed_at).not.toBeNull();
    expect(await repo.countPending(batch.id)).toBe(0);
  });

  it('should drain a large batch with no lost or duplicated jobs', async () => {
    const investors = Array.from({ length: 50 }, (_, i) => `inv-${i}`);
    const { inserted } = await repo.enqueueBatch('2026-06', investors);
    expect(inserted).toBe(50);

    const seen = new Set<string>();
    let guard = 0;
    for (;;) {
      const jobs = await repo.claimJobs(7, 60_000);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        expect(seen.has(job.id)).toBe(false);
        seen.add(job.id);
        await repo.markCompleted(job.id, job.storage_key!, 'sum');
      }
      // Safety valve: a bug that re-claims completed rows would spin here.
      if (++guard > 50) throw new Error('drain did not terminate');
    }

    expect(seen.size).toBe(50);
  });
});
