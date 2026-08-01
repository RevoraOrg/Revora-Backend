/**
 * Tests for database credential rotation (pool.ts).
 *
 * Covers:
 *  - rotatePoolCredentials smoke-test (valid & invalid credentials)
 *  - DB_ROTATION_ENABLED gating
 *  - Listener notification (onCredentialsRotated)
 *  - Metric counters
 */
import {
  pool,
  rotatePoolCredentials,
  onCredentialsRotated,
  clearRotationListeners,
  closeAllPools,
} from '../pool';
import { globalMetrics } from '../../lib/metrics';
import { Pool } from 'pg';

jest.mock('pg', () => {
  const actualPg = jest.requireActual('pg');
  return { ...actualPg, Pool: jest.fn() };
});

const MockedPool = Pool as jest.MockedClass<typeof Pool>;

function mockPoolQuery() {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: jest.fn().mockResolvedValue(undefined),
  };
}

describe('rotatePoolCredentials', () => {
  let mockNewPool: ReturnType<typeof mockPoolQuery>;
  let incrementSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    clearRotationListeners();
    mockNewPool = mockPoolQuery();
    MockedPool.mockImplementation(() => mockNewPool as unknown as Pool);
    incrementSpy = jest.spyOn(globalMetrics, 'incrementCounter').mockImplementation(() => {});
  });

  afterEach(() => { incrementSpy.mockRestore(); });
  afterAll(async () => { await closeAllPools(); });

  it('is a no-op when DB_ROTATION_ENABLED is not "true"', async () => {
    delete process.env.DB_ROTATION_ENABLED;
    await rotatePoolCredentials({ password: 'newpass' });
    expect(MockedPool).not.toHaveBeenCalled();
  });

  it('creates new pool and smoke-tests on success', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    await rotatePoolCredentials({ password: 'newpass123' });
    expect(MockedPool).toHaveBeenCalledTimes(1);
    expect(mockNewPool.query).toHaveBeenCalledWith('SELECT 1');
    expect(incrementSpy).toHaveBeenCalledWith(
      'db.pool.credential_rotation', undefined, 1, expect.any(String),
    );
    delete process.env.DB_ROTATION_ENABLED;
  });

  it('emits failure counter and throws on bad credentials', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    mockNewPool.query.mockRejectedValueOnce(new Error('password auth failed'));
    await expect(rotatePoolCredentials({ password: 'bad' })).rejects.toThrow(/Credential rotation failed/);
    expect(incrementSpy).toHaveBeenCalledWith(
      'db.pool.credential_rotation_failed', undefined, 1, expect.any(String),
    );
    expect(mockNewPool.end).toHaveBeenCalled();
    delete process.env.DB_ROTATION_ENABLED;
  });

  it('notifies listeners on success', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    const cb = jest.fn();
    onCredentialsRotated(cb);
    await rotatePoolCredentials({ password: 'ok' });
    expect(cb).toHaveBeenCalledWith('rotated', { timestamp: expect.any(String) });
    delete process.env.DB_ROTATION_ENABLED;
  });

  it('notifies listeners on failure', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    const cb = jest.fn();
    onCredentialsRotated(cb);
    mockNewPool.query.mockRejectedValueOnce(new Error('bad pw'));
    await expect(rotatePoolCredentials({ password: 'bad' })).rejects.toThrow();
    expect(cb).toHaveBeenCalledWith('failed', { timestamp: expect.any(String), error: 'bad pw' });
    delete process.env.DB_ROTATION_ENABLED;
  });

  it('swallows listener errors', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    onCredentialsRotated(() => { throw new Error('boom'); });
    await rotatePoolCredentials({ password: 'ok' });
    expect(incrementSpy).toHaveBeenCalledWith(
      'db.pool.credential_rotation', undefined, 1, expect.any(String),
    );
    delete process.env.DB_ROTATION_ENABLED;
  });

  it('uses config values over env vars', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    process.env.DB_HOST = 'env-host';
    await rotatePoolCredentials({ host: 'cfg-host', password: 'pw' });
    expect(MockedPool.mock.calls[0]?.[0]).toMatchObject({ host: 'cfg-host' });
    delete process.env.DB_ROTATION_ENABLED;
    delete process.env.DB_HOST;
  });

  it('clearRotationListeners removes all callbacks', async () => {
    process.env.DB_ROTATION_ENABLED = 'true';
    const cb = jest.fn();
    onCredentialsRotated(cb);
    clearRotationListeners();
    await rotatePoolCredentials({ password: 'pw' });
    expect(cb).not.toHaveBeenCalled();
    delete process.env.DB_ROTATION_ENABLED;
  });
});
