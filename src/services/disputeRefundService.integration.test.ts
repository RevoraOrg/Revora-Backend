import { execFileSync } from 'child_process';
import { Pool } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DisputeRefundService } from './disputeRefundService';

function containerRuntimeAvailable(): boolean {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 22)) return false;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const hasContainerRuntime = containerRuntimeAvailable();
const describeWithPostgres = hasContainerRuntime ? describe : describe.skip;

if (!hasContainerRuntime) {
  console.warn(
    '[disputeRefundService.integration] Docker or Node.js >=22.22 is unavailable; skipping real-Postgres concurrency test.',
  );
}

describeWithPostgres('DisputeRefundService (real Postgres)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new Pool({ connectionString: container.getConnectionUri() });

    await pool.query(`
      CREATE TABLE distributions (
        id UUID PRIMARY KEY,
        total_amount NUMERIC(30, 10) NOT NULL
      );
      CREATE TABLE distribution_payouts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        distribution_id UUID NOT NULL REFERENCES distributions(id),
        investor_id UUID NOT NULL,
        amount NUMERIC(30, 10) NOT NULL,
        status TEXT NOT NULL DEFAULT 'processed',
        tx_hash TEXT,
        frozen_fx_rate_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE dispute_refunds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dispute_id UUID NOT NULL,
        amount NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
        reason TEXT,
        ledger_event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE dispute_ledger_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        dispute_id UUID NOT NULL,
        investor_id UUID NOT NULL,
        amount NUMERIC(19, 4) NOT NULL,
        type VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO distributions (id, total_amount)
      VALUES ('00000000-0000-4000-8000-000000000001', 100);
      INSERT INTO distribution_payouts (distribution_id, investor_id, amount)
      VALUES
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 60),
        ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 40);
    `);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('allows only one of two concurrent refunds whose combined amount exceeds the distribution cap', async () => {
    const service = new DisputeRefundService(pool);
    const requests = [
      service.processPartialRefund({
        disputeId: '00000000-0000-4000-8000-000000000021',
        distributionId: '00000000-0000-4000-8000-000000000001',
        amount: '60.0000',
      }),
      service.processPartialRefund({
        disputeId: '00000000-0000-4000-8000-000000000021',
        distributionId: '00000000-0000-4000-8000-000000000001',
        amount: '60.0000',
      }),
    ];
    const outcomes = await Promise.allSettled(requests);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const totals = await pool.query(
      `SELECT
         (SELECT SUM(amount) FROM dispute_refunds WHERE dispute_id = $1) AS refunds,
         (SELECT SUM(amount) FROM dispute_ledger_events WHERE dispute_id = $1 AND type = 'refund_reversal') AS reversals`,
      ['00000000-0000-4000-8000-000000000021'],
    );
    expect(totals.rows[0].refunds).toBe('60.0000');
    expect(totals.rows[0].reversals).toBe('-60.0000');
  });
});
