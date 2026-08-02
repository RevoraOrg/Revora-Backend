/**
 * DB Pool Saturation Tests
 *
 * Covers the `getDbPoolSaturation` family of helpers that back the
 * `db.pool.waiters` / `db.pool.utilization` autoscaling gauges.
 *
 * The helpers read pg Pool counters synchronously and never issue queries,
 * so fake pool objects are sufficient — no database is required.
 *
 * @module db/pool.test
 */

import { Pool } from 'pg';
import {
  getDbPoolSaturation,
  getPrimaryPoolSaturation,
  getReplicaPoolSaturation,
  DbPoolSaturation,
} from './pool';

function fakePool(overrides: Partial<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  options: { max?: number };
}> = {}): Pool {
  return {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    options: {},
    ...overrides,
  } as unknown as Pool;
}

describe('getDbPoolSaturation', () => {
  it('reports a defined zero saturation for an idle pool', () => {
    const saturation = getDbPoolSaturation(fakePool());

    expect(saturation).toEqual({
      waiters: 0,
      total: 0,
      idle: 0,
      active: 0,
      max: 10,
      utilization: 0,
    });
    expect(Number.isFinite(saturation.utilization)).toBe(true);
  });

  it('computes utilization from active connections and configured max', () => {
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 5, idleCount: 1, waitingCount: 2, options: { max: 10 } }),
    );

    expect(saturation.waiters).toBe(2);
    expect(saturation.total).toBe(5);
    expect(saturation.idle).toBe(1);
    expect(saturation.active).toBe(4);
    expect(saturation.max).toBe(10);
    expect(saturation.utilization).toBeCloseTo(0.4, 10);
  });

  it('reports a fully saturated pool as utilization 1', () => {
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 10, idleCount: 0, waitingCount: 6, options: { max: 10 } }),
    );

    expect(saturation.active).toBe(10);
    expect(saturation.utilization).toBe(1);
    expect(saturation.waiters).toBe(6);
  });

  it('clamps utilization to 1 when active exceeds max', () => {
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 12, idleCount: 0, options: { max: 10 } }),
    );

    expect(saturation.utilization).toBe(1);
  });

  it('falls back to a default max when the pool has no max configured', () => {
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 4, idleCount: 0, options: {} }),
    );

    expect(saturation.max).toBe(10);
    expect(saturation.utilization).toBeCloseTo(0.4, 10);
  });

  it('defines utilization as 0 when the pool max is 0', () => {
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 3, idleCount: 0, options: { max: 0 } }),
    );

    expect(saturation.max).toBe(0);
    expect(saturation.utilization).toBe(0);
  });

  it('never reports a negative active count', () => {
    // Defensive: idleCount should never exceed totalCount, but clamp anyway.
    const saturation = getDbPoolSaturation(
      fakePool({ totalCount: 2, idleCount: 9, options: { max: 10 } }),
    );

    expect(saturation.active).toBe(0);
    expect(saturation.utilization).toBe(0);
  });
});

describe('getPrimaryPoolSaturation', () => {
  it('returns a snapshot for the primary pool without throwing', () => {
    const saturation: DbPoolSaturation = getPrimaryPoolSaturation();

    expect(saturation.max).toBeGreaterThan(0);
    expect(saturation.utilization).toBeGreaterThanOrEqual(0);
    expect(saturation.utilization).toBeLessThanOrEqual(1);
    expect(saturation.waiters).toBeGreaterThanOrEqual(0);
  });
});

describe('getReplicaPoolSaturation', () => {
  it('returns null when no replica pool is configured', () => {
    // REPLICA_DB_URL is not set in the test environment, so no replica pool
    // is created at module load.
    expect(getReplicaPoolSaturation()).toBeNull();
  });
});
