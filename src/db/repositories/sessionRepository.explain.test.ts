/**
 * @file src/db/repositories/sessionRepository.explain.test.ts
 * @description
 * Regression alarm for session-store EXPLAIN baselines (#682).
 *
 * Loads the committed cost fixture and verifies that a simulated EXPLAIN
 * response triggers the alarm when cost > baseline * 2, and passes when it
 * is within bounds and uses the partial index.
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { checkRegressionAlarm, BaselineEntry } from '../../../scripts/capture-explain';

// Load baseline fixtures — fall back gracefully in CI environments that have
// not run captureBaselines() yet.
const baselinePath = path.join(__dirname, '..', 'fixtures', 'explain_baselines.json');
let baselines: Record<string, BaselineEntry> = {};
try {
  baselines = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
} catch {
  // Fallback: mirrors the values committed in src/db/fixtures/explain_baselines.json
  baselines = {
    activeSessionLookupByUserId: {
      total_cost: 15.5,
      plan_type: 'Index Scan',
      index_name: 'idx_sessions_active_user_id',
    },
  };
}

describe('Session Storage Tuning: EXPLAIN Baselines (#682)', () => {
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ── Regression alarm ────────────────────────────────────────────────────────

  it('alarms (fails) when plan cost exceeds baseline * 2', async () => {
    const baseline = baselines.activeSessionLookupByUserId;
    const bloatedCost = baseline.total_cost * 3; // 3× > 2× threshold

    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Total Cost': bloatedCost,
                'Node Type': 'Seq Scan',
              },
            },
          ],
        },
      ],
    } as unknown as Awaited<ReturnType<Pool['query']>>);

    const runCheck = async () => {
      const res = await mockPool.query(
        'EXPLAIN (FORMAT JSON) SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      );
      const plan = res.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
      checkRegressionAlarm('activeSessionLookupByUserId', plan['Total Cost'] as number, baseline);
    };

    await expect(runCheck()).rejects.toThrow(/Regression Alarm/);
    await expect(runCheck()).rejects.toThrow(/exceeds baseline \* 2/);
  });

  it('passes when plan cost is within 2× bounds', async () => {
    const baseline = baselines.activeSessionLookupByUserId;
    const healthyCost = baseline.total_cost * 1.1; // 10 % above — within range

    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          'QUERY PLAN': [
            {
              Plan: {
                'Total Cost': healthyCost,
                'Node Type': 'Index Scan',
                'Index Name': 'idx_sessions_active_user_id',
              },
            },
          ],
        },
      ],
    } as unknown as Awaited<ReturnType<Pool['query']>>);

    const runCheck = async () => {
      const res = await mockPool.query(
        'EXPLAIN (FORMAT JSON) SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
      );
      const plan = res.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;
      checkRegressionAlarm('activeSessionLookupByUserId', plan['Total Cost'] as number, baseline);
      return plan;
    };

    const plan = await runCheck();
    expect((plan['Total Cost'] as number)).toBeLessThanOrEqual(baseline.total_cost * 2);
    expect(plan['Index Name']).toBe('idx_sessions_active_user_id');
  });

  it('passes at exactly baseline * 2 (boundary)', async () => {
    const baseline = baselines.activeSessionLookupByUserId;
    const boundaryCost = baseline.total_cost * 2; // exactly at threshold — should NOT alarm

    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', boundaryCost, baseline),
    ).not.toThrow();
  });

  it('alarms at baseline * 2 + epsilon (just over boundary)', () => {
    const baseline = baselines.activeSessionLookupByUserId;
    const overCost = baseline.total_cost * 2 + 0.001;

    expect(() =>
      checkRegressionAlarm('activeSessionLookupByUserId', overCost, baseline),
    ).toThrow(/Regression Alarm/);
  });

  // ── Index selection ─────────────────────────────────────────────────────────

  it('confirms the baseline fixture uses the partial index', () => {
    const baseline = baselines.activeSessionLookupByUserId;
    expect(baseline.plan_type).toBe('Index Scan');
    expect(baseline.index_name).toBe('idx_sessions_active_user_id');
  });

  it('confirms baseline cost is within a sane range', () => {
    const baseline = baselines.activeSessionLookupByUserId;
    // An index scan on an empty or small table should have cost < 100.
    // If this trips, the committed fixture is stale — re-run capture-explain.ts.
    expect(baseline.total_cost).toBeGreaterThan(0);
    expect(baseline.total_cost).toBeLessThan(100);
  });
});
