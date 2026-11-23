import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PgSpendStore } from './pgSpendStore';

const testUrl = process.env.FX_SPEND_TEST_DATABASE_URL;

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
    '[FX spend integration] Set FX_SPEND_TEST_DATABASE_URL or start Docker to run real-Postgres tests.',
  );
}

(available ? describe : describe.skip)('PgSpendStore (real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let container: StartedPostgreSqlContainer | undefined;
  let admin: Pool;
  let poolA: Pool;
  let poolB: Pool;
  let storeA: PgSpendStore;
  let storeB: PgSpendStore;
  const schema = `fx_spend_test_${randomUUID().replace(/-/g, '')}`;
  const tenant = 'integration-tenant';
  const month = '2026-11';
  const migration = readFileSync(
    join(__dirname, '../db/migrations/062_create_fx_provider_spend.sql'),
    'utf8',
  );

  beforeAll(async () => {
    const connectionString = testUrl ?? (await (async () => {
      container = await new PostgreSqlContainer('postgres:16-alpine').start();
      return container.getConnectionUri();
    })());
    admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const options = `-c search_path=${schema}`;
    poolA = new Pool({ connectionString, options, max: 2 });
    poolB = new Pool({ connectionString, options, max: 2 });
    await poolA.query(migration);
    storeA = new PgSpendStore(poolA);
    storeB = new PgSpendStore(poolB);
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

  beforeEach(async () => {
    await poolA.query('TRUNCATE fx_provider_spend');
  });

  it('serializes concurrent increments across pools and persists across store instances', async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).increment(
          tenant,
          'provider-a',
          month,
          0.01,
        ),
      ),
    );

    const restartedStore = new PgSpendStore(poolB);
    expect(await restartedStore.get(tenant, 'provider-a', month)).toBe(1);
  });

  it('lists spend for only the requested tenant and month', async () => {
    await storeA.increment(tenant, 'provider-a', month, 2.5);
    await storeA.increment('other-tenant', 'provider-a', month, 20);
    await storeA.increment(tenant, 'provider-b', '2026-10', 30);

    await expect(storeB.listByTenant(tenant, month)).resolves.toEqual([
      {
        tenantId: tenant,
        providerId: 'provider-a',
        monthKey: month,
        spendUsd: 2.5,
      },
    ]);
  });
});
