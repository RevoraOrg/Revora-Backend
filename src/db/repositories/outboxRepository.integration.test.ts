import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { OutboxRepository, OutboxRow } from './outboxRepository';
import { OutboxDispatcher } from '../../services/outboxDispatcher';
import { WebhookEventType } from '../../services/webhookService';

// Explicit test URL only: never fall back to the application's DATABASE_URL.
const testUrl = process.env.OUTBOX_TEST_DATABASE_URL;
function hasDocker(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}
const available = Boolean(testUrl) || hasDocker();
if (!available) console.warn('[outbox integration] Set OUTBOX_TEST_DATABASE_URL or start Docker to run real-Postgres tests.');

(available ? describe : describe.skip)('Outbox leases (real PostgreSQL)', () => {
  jest.setTimeout(120_000);
  let container: StartedPostgreSqlContainer | undefined;
  let admin: Pool;
  let poolA: Pool;
  let poolB: Pool;
  let workerA: OutboxRepository;
  let workerB: OutboxRepository;
  const schema = `outbox_test_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    const connectionString = testUrl ?? (await (async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      return container.getConnectionUri();
    })());
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = `-c search_path=${schema}`;
    poolA = new Pool({ connectionString, options, max: 1 });
    poolB = new Pool({ connectionString, options, max: 1 });
    await poolA.query(`CREATE FUNCTION update_updated_at_column() RETURNS trigger AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    for (const migration of ['029_create_webhook_outbox.sql', '061_add_webhook_outbox_leases.sql']) {
      await poolA.query(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
    }
    workerA = new OutboxRepository(poolA);
    workerB = new OutboxRepository(poolB);
    const [a, b] = await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'), poolB.query('SELECT pg_backend_pid() AS pid')]);
    expect(a.rows[0].pid).not.toBe(b.rows[0].pid);
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
    await container?.stop();
  });

  beforeEach(async () => { await poolA.query('TRUNCATE webhook_outbox'); });
  const insert = () => workerA.insert({ event_type: WebhookEventType.PAYOUT_COMPLETED, payload: { amount: 10 } });
  const expire = (id: string) => poolA.query("UPDATE webhook_outbox SET locked_until = NOW() - INTERVAL '1 second' WHERE id = $1", [id]);

  it('prevents concurrent drainOnce calls from dispatching the same id while the first delivery is blocked', async () => {
    const row = await insert();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const seenA: string[] = [];
    const seenB: string[] = [];
    const first = new OutboxDispatcher(workerA, async claimed => {
      seenA.push(claimed.id);
      entered();
      await blocked;
      return true;
    });
    const second = new OutboxDispatcher(workerB, async claimed => { seenB.push(claimed.id); return true; });
    const draining = first.drainOnce();
    try {
      await Promise.race([started, draining.then(() => { throw new Error('First worker did not dispatch'); })]);
      expect(await second.drainOnce()).toBe(0);
      expect(seenA).toEqual([row.id]);
      expect(seenB).toEqual([]);
    } finally {
      release();
      await draining;
    }
  });

  it('claims disjoint batches from two independent pool clients', async () => {
    for (let i = 0; i < 12; i++) await insert();
    const [a, b] = await Promise.all([workerA.drainPending(6), workerB.drainPending(6)]);
    expect(a).toHaveLength(6);
    expect(b).toHaveLength(6);
    expect(new Set([...a, ...b].map(row => row.id)).size).toBe(12);
    expect([...a, ...b].every(row => row.status === 'dispatching' && row.lease_token && row.locked_until)).toBe(true);
    expect(await workerA.drainPending()).toEqual([]);
  });

  it('skips a row locked by another transaction without waiting', async () => {
    const first = await insert();
    const second = await insert();
    const client = await poolA.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM webhook_outbox WHERE id = $1 FOR UPDATE', [first.id]);
      await poolB.query("SET statement_timeout = '2s'");
      expect((await workerB.drainPending()).map(row => row.id)).toEqual([second.id]);
    } finally {
      await poolB.query('RESET statement_timeout');
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('reclaims an expired crash lease and fences the old worker from every completion path', async () => {
    const original = await insert();
    const [old] = await workerA.drainPending(1);
    expect(await workerB.drainPending()).toEqual([]);
    await expire(old.id);
    const [current] = await workerB.drainPending(1);
    expect(current.id).toBe(original.id);
    expect(current.event_id).toBe(original.event_id);
    expect(current.lease_token).not.toBe(old.lease_token);
    await workerA.markDispatched(old.id, old.lease_token!);
    await workerA.markFailed(old.id, old.lease_token!);
    await workerA.markFailed(old.id, old.lease_token!, new Date());
    const raw = await poolA.query('SELECT * FROM webhook_outbox WHERE id = $1', [old.id]);
    expect(raw.rows[0].status).toBe('dispatching');
    expect(raw.rows[0].lease_token).toBe(current.lease_token);
    expect(raw.rows[0].attempts).toBe(0);
    await workerB.markDispatched(current.id, current.lease_token!);
    const done = await poolA.query('SELECT * FROM webhook_outbox WHERE id = $1', [old.id]);
    expect(done.rows[0]).toMatchObject({ status: 'dispatched', attempts: 1, locked_until: null, lease_token: null });
  });

  it('rejects expired completions even before reclamation', async () => {
    await insert();
    const [row] = await workerA.drainPending();
    await expire(row.id);
    await workerA.markDispatched(row.id, row.lease_token!);
    await workerA.markFailed(row.id, row.lease_token!);
    await workerA.markFailed(row.id, row.lease_token!, new Date());
    expect((await poolA.query('SELECT status, attempts FROM webhook_outbox')).rows[0]).toEqual({ status: 'dispatching', attempts: 0 });
    expect(await workerB.drainPending()).toHaveLength(1);
  });

  it('releases retry leases, respects availability, and dead-letters without reclaiming terminal rows', async () => {
    await insert();
    const [row] = await workerA.drainPending();
    await workerA.markFailed(row.id, row.lease_token!, new Date(Date.now() + 60_000));
    expect((await poolA.query('SELECT * FROM webhook_outbox')).rows[0]).toMatchObject({ status: 'pending', attempts: 1, locked_until: null, lease_token: null });
    expect(await workerB.drainPending()).toEqual([]);
    await poolA.query("UPDATE webhook_outbox SET available_at = NOW() - INTERVAL '1 second'");
    const [retry] = await workerB.drainPending();
    await workerB.markFailed(retry.id, retry.lease_token!);
    expect((await poolA.query('SELECT * FROM webhook_outbox')).rows[0]).toMatchObject({ status: 'failed', attempts: 2, locked_until: null, lease_token: null });
    expect(await workerA.drainPending()).toEqual([]);
  });

  it('excludes live leases and scheduled rows from lag, but includes expired recoverable work', async () => {
    const first = await insert();
    expect((await workerA.getOldestPending())?.id).toBe(first.id);
    await workerA.drainPending();
    expect(await workerB.getOldestPending()).toBeNull();
    await expire(first.id);
    expect((await workerB.getOldestPending())?.id).toBe(first.id);
    const [reclaimed] = await workerB.drainPending();
    await workerB.markFailed(reclaimed.id, reclaimed.lease_token!, new Date(Date.now() + 60_000));
    expect(await workerA.getOldestPending()).toBeNull();
  });

  it('reproduces the master autocommit SELECT bug independently of the fixed claim', async () => {
    const row = await insert();
    const legacy = `SELECT * FROM webhook_outbox WHERE status = 'pending' AND available_at <= NOW()
      ORDER BY available_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`;
    // The first statement has committed before its delivery completes. Its lock
    // is gone, so a second worker's query returns exactly the same row.
    const a = await poolA.query<OutboxRow>(legacy, [1]);
    const b = await poolB.query<OutboxRow>(legacy, [1]);
    expect(a.rows[0].id).toBe(row.id);
    expect(b.rows[0].id).toBe(row.id);
  });
});
