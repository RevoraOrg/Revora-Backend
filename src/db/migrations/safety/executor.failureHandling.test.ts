import fs from 'fs';
import type { Pool } from 'pg';

import { HardenedMigrationExecutor } from './executor';
import type { MigrationSecurityContext } from './types';

const securityContext: MigrationSecurityContext = {
  userId: 'admin-1',
  userRole: 'admin',
  sessionId: 'session-1',
  requestId: 'request-1',
  environment: 'development',
  timestamp: new Date('2026-09-30T00:00:00.000Z'),
  ipAddress: '127.0.0.1',
  userAgent: 'jest',
};

function makePool(): Pool {
  return {
    connect: jest.fn(),
    query: jest.fn(),
  } as unknown as Pool;
}

describe('HardenedMigrationExecutor failure contracts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a successful dry-run result for a valid migration and options', async () => {
    const executor = new HardenedMigrationExecutor(makePool());
    const migrationPath = '/migrations/004_create_users.sql';
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      'CREATE TABLE users (id UUID PRIMARY KEY);',
    );

    const result = await executor.executeMigration(migrationPath, securityContext, {
      dryRun: true,
      skipBackup: true,
      timeout: 1_000,
      batchSize: 100,
    });

    expect(result).toMatchObject({
      success: true,
      status: 'completed',
      migrationFile: { filename: '004_create_users.sql' },
    });
    expect(result.stepsExecuted).toBeGreaterThan(0);
  });

  it('returns a structured failure for a missing migration file', async () => {
    const executor = new HardenedMigrationExecutor(makePool());
    jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: migration does not exist');
    });

    const result = await executor.executeMigration(
      '/definitely-missing/991_missing.sql',
      securityContext,
      { dryRun: true },
    );

    expect(result).toMatchObject({
      success: false,
      executionId: 'failed',
      status: 'failed',
      migrationFile: {
        filename: '991_missing.sql',
        filepath: '/definitely-missing/991_missing.sql',
      },
      stepsExecuted: 0,
      rollbackAvailable: false,
    });
    expect(result.error).toMatch(/^Failed to load migration file:/);
  });

  it.each([
    ['timeout', { timeout: 0 }],
    ['timeout', { timeout: Number.NaN }],
    ['batchSize', { batchSize: -1 }],
    ['batchSize', { batchSize: 1.5 }],
  ] as const)('rejects invalid %s boundaries as structured failures', async (name, options) => {
    const pool = makePool();
    const executor = new HardenedMigrationExecutor(pool);

    const result = await executor.executeMigration('unused.sql', securityContext, options);

    expect(result).toMatchObject({
      success: false,
      executionId: 'failed',
      status: 'failed',
      stepsExecuted: 0,
      error: `${name} must be a positive integer when provided`,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each(['unknown-execution', '', '   '])(
    'returns null when migration status %j is unavailable',
    async (executionId) => {
      const pool = makePool();
      const executor = new HardenedMigrationExecutor(pool);

      await expect(executor.getMigrationStatus(executionId)).resolves.toBeNull();
      expect(pool.query).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
    },
  );
});
