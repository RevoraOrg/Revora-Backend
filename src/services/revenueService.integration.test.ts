import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { ErrorCode } from '../lib/errors';
import { RevenueService } from './revenueService';

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
  console.warn(
    '[revenueService.integration] No Docker runtime detected; real-Postgres concurrency assertions are skipped.',
  );
}

const describeWithPostgres = RUNTIME_AVAILABLE ? describe : describe.skip;

describeWithPostgres('RevenueService concurrency (real Postgres)', () => {
  jest.setTimeout(120_000);

  const offeringId = '123e4567-e89b-42d3-a456-426614174000';
  const issuerId = '123e4567-e89b-42d3-a456-426614174001';
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let service: RevenueService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    await pool.query(`
      CREATE TABLE offerings (
        id UUID PRIMARY KEY,
        issuer_id UUID NOT NULL
      );
      CREATE TABLE revenue_reports (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        offering_id UUID NOT NULL,
        amount NUMERIC(30, 10) NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        reported_by UUID NOT NULL DEFAULT gen_random_uuid(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query('INSERT INTO offerings (id, issuer_id) VALUES ($1, $2)', [
      offeringId,
      issuerId,
    ]);

    service = new RevenueService(
      new OfferingRepository(pool),
      new RevenueReportRepository(pool),
      undefined,
      pool,
    );
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('allows only one of two concurrent overlapping submissions', async () => {
    const submission = {
      offeringId,
      issuerId,
      amount: '100.50',
      periodStart: new Date('2026-01-01T00:00:00.000Z'),
      periodEnd: new Date('2026-02-01T00:00:00.000Z'),
    };

    const outcomes = await Promise.allSettled([
      service.submitReport(submission),
      service.submitReport(submission),
    ]);
    const successful = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    const persisted = await pool.query(
      'SELECT COUNT(*)::int AS count FROM revenue_reports WHERE offering_id = $1',
      [offeringId],
    );

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: { code: ErrorCode.CONFLICT },
    });
    expect(persisted.rows[0].count).toBe(1);
  });
});
