import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PostgresAdminNonceStore } from './adminSignature';

/**
 * Gated integration coverage for the Postgres-backed admin nonce store.
 *
 * Runs against `ADMIN_NONCE_TEST_DATABASE_URL` when set, or a throwaway
 * Testcontainers PostgreSQL instance when Docker is available. Skipped
 * otherwise so unit-only CI environments stay hermetic. We never fall back to
 * the application's DATABASE_URL: these tests create and drop schemas.
 */

// Explicit test URL only: never fall back to the application's DATABASE_URL.
const testUrl = process.env.ADMIN_NONCE_TEST_DATABASE_URL;

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const available = Boolean(testUrl) || hasDocker();
if (!available) {
  console.warn(
    '[admin nonce integration] Set ADMIN_NONCE_TEST_DATABASE_URL or start Docker to run real-Postgres tests.',
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(available ? describe : describe.skip)('PostgresAdminNonceStore (real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer | undefined;
  let admin: Pool;
  let poolA: Pool;
  let poolB: Pool;
  const schema = `admin_nonce_test_${randomUUID().replace(/-/g, '')}`;

  beforeAll(async () => {
    const connectionString =
      testUrl ??
      (await (async () => {
        container = await new PostgreSqlContainer('postgres:16-alpine').start();
        return container.getConnectionUri();
      })());

    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);

    const options = `-c search_path=${schema}`;
    poolA = new Pool({ connectionString, options, max: 1 });
    poolB = new Pool({ connectionString, options, max: 1 });

    await poolA.query(
      readFileSync(
        join(__dirname, '../db/migrations/062_create_admin_nonce_store.sql'),
        'utf8',
      ),
    );
  });

  afterAll(async () => {
    await poolA?.end();
    await poolB?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
    await container?.stop();
  });

  it('rejects a replay of the same (kid, nonce) against a second replica', async () => {
    const replicaA = new PostgresAdminNonceStore({ pool: poolA });
    const replicaB = new PostgresAdminNonceStore({ pool: poolB });

    await expect(replicaA.consume('kid-a', 'nonce-1', 60_000)).resolves.toBe(true);
    // A different pool/connection simulates another process: the shared row
    // must make the duplicate a replay.
    await expect(replicaB.consume('kid-a', 'nonce-1', 60_000)).resolves.toBe(false);
  });

  it('scopes nonces per admin key id', async () => {
    const store = new PostgresAdminNonceStore({ pool: poolA });

    await expect(store.consume('kid-a', 'shared-nonce', 60_000)).resolves.toBe(true);
    // A nonce is only single-use for the key that signed it.
    await expect(store.consume('kid-b', 'shared-nonce', 60_000)).resolves.toBe(true);
  });

  it('serialises concurrent duplicate submissions so exactly one wins', async () => {
    const replicaA = new PostgresAdminNonceStore({ pool: poolA });
    const replicaB = new PostgresAdminNonceStore({ pool: poolB });

    const results = await Promise.all([
      replicaA.consume('kid-a', 'concurrent-nonce', 60_000),
      replicaB.consume('kid-a', 'concurrent-nonce', 60_000),
    ]);

    expect(results.sort()).toEqual([false, true]);
  });

  it('allows reuse after the record expires', async () => {
    const store = new PostgresAdminNonceStore({ pool: poolA });

    await expect(store.consume('kid-a', 'expiring-nonce', 25)).resolves.toBe(true);
    await expect(store.consume('kid-a', 'expiring-nonce', 25)).resolves.toBe(false);
    await sleep(60);
    await expect(store.consume('kid-a', 'expiring-nonce', 25)).resolves.toBe(true);
  });

  it('cleans up expired rows without touching live ones', async () => {
    const store = new PostgresAdminNonceStore({ pool: poolA });

    await expect(store.consume('kid-a', 'short-lived', 25)).resolves.toBe(true);
    await expect(store.consume('kid-a', 'long-lived', 60_000)).resolves.toBe(true);

    await sleep(60);
    const deleted = await store.cleanupExpired();

    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await poolA.query(
      'SELECT nonce FROM admin_nonces WHERE kid = $1 AND nonce = $2',
      ['kid-a', 'long-lived'],
    );
    expect(remaining.rowCount).toBe(1);
  });
});
