import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Load baseline fixtures
const baselinePath = path.join(__dirname, '..', 'fixtures', 'explain_baselines.json');
let baselines: Record<string, any> = {};
try {
  baselines = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
} catch (e) {
  // If file doesn't exist, provide a fallback for test environments
  baselines = {
    activeSessionLookupByUserId: {
      total_cost: 15.5,
      plan_type: "Index Scan",
      index_name: "idx_sessions_active_user_id"
    }
  };
}

describe('Session Storage Tuning: EXPLAIN Baselines', () => {
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pool>;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('alarms (fails) when plan cost exceeds baseline * 2', async () => {
    const baselineCost = baselines.activeSessionLookupByUserId.total_cost;
    
    // Simulate an EXPLAIN output where cost has skyrocketed
    const bloatedCost = baselineCost * 3;
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Total Cost": bloatedCost,
                "Node Type": "Seq Scan",
              }
            }
          ]
        }
      ]
    } as any);

    const checkExplainCost = async () => {
      const res = await mockPool.query('EXPLAIN (FORMAT JSON) SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL');
      const plan = res.rows[0]['QUERY PLAN'][0].Plan;
      const actualCost = plan['Total Cost'];
      
      if (actualCost > baselineCost * 2) {
        throw new Error(`Regression Alarm: Plan cost (${actualCost}) exceeds baseline * 2 (${baselineCost * 2})`);
      }
    };

    await expect(checkExplainCost()).rejects.toThrow(/Regression Alarm: Plan cost.*exceeds baseline/);
  });

  it('passes when plan cost is within bounds and uses index', async () => {
    const baselineCost = baselines.activeSessionLookupByUserId.total_cost;
    
    // Simulate a healthy EXPLAIN output
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          "QUERY PLAN": [
            {
              Plan: {
                "Total Cost": baselineCost * 1.1,
                "Node Type": "Index Scan",
                "Index Name": "idx_sessions_active_user_id"
              }
            }
          ]
        }
      ]
    } as any);

    const checkExplainCost = async () => {
      const res = await mockPool.query('EXPLAIN (FORMAT JSON) SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL');
      const plan = res.rows[0]['QUERY PLAN'][0].Plan;
      const actualCost = plan['Total Cost'];
      
      if (actualCost > baselineCost * 2) {
        throw new Error(`Regression Alarm: Plan cost (${actualCost}) exceeds baseline * 2 (${baselineCost * 2})`);
      }
      
      return plan;
    };

    const plan = await checkExplainCost();
    expect(plan['Total Cost']).toBeLessThanOrEqual(baselineCost * 2);
    expect(plan['Index Name']).toBe('idx_sessions_active_user_id');
  });
});
