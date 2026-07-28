/**
 * CaseAssignmentService Tests
 *
 * Covers: assignment eligibility, cool-down enforcement, capacity limits,
 * batch assignment, age-days histogram, error paths.
 */

import { CaseAssignmentService } from './caseAssignmentService';
import { ReviewerProfile } from './types';
import { MetricsCollector } from '../lib/metrics';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePool(rows: Record<string, unknown>[][] = [], queries: string[] = []) {
  const queryFn = jest.fn().mockImplementation(async (_sql: string, _params?: unknown[]) => {
    const idx = queries.length;
    queries.push(_sql);
    const result = rows[idx] ?? [];
    return { rows: result };
  });

  return { query: queryFn } as unknown as import('pg').Pool;
}

function makeMetrics() {
  return {
    recordHistogram: jest.fn(),
    incrementCounter: jest.fn(),
    setGauge: jest.fn(),
  } as unknown as MetricsCollector;
}

function makeProfile(
  id: string,
  max = 10,
  coolDownHours = 24,
): ReviewerProfile {
  return { reviewer_id: id, max_capacity: max, cool_down_hours: coolDownHours };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CaseAssignmentService', () => {
  // ── assignCase ────────────────────────────────────────────────────────────

  describe('assignCase', () => {
    it('assigns open case to least-loaded eligible reviewer and emits histogram', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(5) }],
        [{ assigned_to: 'r1', active_count: 2 }],
        [{ assigned_to: 'r1', last_closed_at: daysAgo(3) }],
      ];
      const queries: string[] = [];
      const pool = makePool(rows, queries);
      const metrics = makeMetrics();
      const profiles = [makeProfile('r1'), makeProfile('r2')];
      const svc = new CaseAssignmentService(pool, metrics, profiles);

      const result = await svc.assignCase('c1');

      expect(result.case_id).toBe('c1');
      expect(result.assigned_to).toBe('r2'); // r1 has 2 active, r2 has 0
      expect(result.age_days).toBe(5);
      expect(metrics.recordHistogram).toHaveBeenCalledWith(
        'aml.case.age_days',
        5,
        expect.any(Object),
        expect.any(String),
      );

      // UPDATE query was issued
      expect(queries[3]).toContain('UPDATE aml_cases');
    });

    it('throws NOT_FOUND when case does not exist', async () => {
      const rows = [[]]; // fetchOpenCase returns 0 rows
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      await expect(svc.assignCase('nonexistent')).rejects.toThrow('not found');
    });

    it('throws CONFLICT when case is not in open status', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'assigned', created_at: daysAgo(1) }],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      await expect(svc.assignCase('c1')).rejects.toThrow('assigned');
    });

    it('throws CONFLICT when no reviewer is eligible (all at capacity)', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(1) }],
        [{ assigned_to: 'r1', active_count: 10 }], // at capacity
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10)]);

      await expect(svc.assignCase('c1')).rejects.toThrow('No eligible reviewer');
    });

    it('throws CONFLICT when all reviewers are in cool-down', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(1) }],
        [{ assigned_to: 'r1', active_count: 0 }],
        [{ assigned_to: 'r1', last_closed_at: daysAgo(0) }], // closed < 24h ago
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      // Short cool-down of 48h so the close from "today" is still in CD
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10, 48)]);

      await expect(svc.assignCase('c1')).rejects.toThrow('No eligible reviewer');
    });

    it('assigns to reviewer with higher remaining capacity (least-loaded)', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(2) }],
        [
          { assigned_to: 'r1', active_count: 7 },
          { assigned_to: 'r2', active_count: 3 },
        ],
        [], // no close history
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(
        pool,
        metrics,
        [makeProfile('r1'), makeProfile('r2')],
      );

      const result = await svc.assignCase('c1');
      expect(result.assigned_to).toBe('r2'); // 7 remaining vs 3 remaining
    });

    it('breaks tie alphabetically by reviewer_id', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(1) }],
        [
          { assigned_to: 'a_reviewer', active_count: 5 },
          { assigned_to: 'b_reviewer', active_count: 5 },
        ],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(
        pool,
        metrics,
        [makeProfile('b_reviewer'), makeProfile('a_reviewer')],
      );

      const result = await svc.assignCase('c1');
      expect(result.assigned_to).toBe('a_reviewer');
    });
  });

  // ── assignAllOpenCases ────────────────────────────────────────────────────

  describe('assignAllOpenCases', () => {
    it('assigns multiple open cases oldest-first', async () => {
      const cOld = { id: 'c_old', alert_ids: [], investor_id: 'i1', status: 'open', created_at: daysAgo(10) };
      const cNew = { id: 'c_new', alert_ids: [], investor_id: 'i1', status: 'open', created_at: daysAgo(1) };
      const rows = [
        [cOld, cNew],                         // idx 0: fetchAllOpenCases
        [cOld],                                // idx 1: fetchOpenCase(c_old)
        [{ assigned_to: 'r1', active_count: 0 }], // idx 2: count(c_old)
        [],                                    // idx 3: close(c_old)
        [],                                    // idx 4: UPDATE(c_old)
        [cNew],                                // idx 5: fetchOpenCase(c_new)
        [{ assigned_to: 'r1', active_count: 1 }], // idx 6: count(c_new)
        [],                                    // idx 7: close(c_new)
        [],                                    // idx 8: UPDATE(c_new)
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const results = await svc.assignAllOpenCases();

      expect(results).toHaveLength(2);
      expect(results[0].case_id).toBe('c_old');
      expect(results[1].case_id).toBe('c_new');
    });

    it('stops assigning when no reviewer is eligible', async () => {
      const rows = [
        [
          { id: 'c1', alert_ids: [], investor_id: 'i1', status: 'open', created_at: daysAgo(5) },
          { id: 'c2', alert_ids: [], investor_id: 'i1', status: 'open', created_at: daysAgo(3) },
        ],
        // For c1: r1 at capacity
        [{ assigned_to: 'r1', active_count: 10 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10)]);

      const results = await svc.assignAllOpenCases();
      expect(results).toHaveLength(0);
    });

    it('returns empty array when no open cases exist', async () => {
      const rows = [[]]; // fetchAllOpenCases returns 0 rows
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const results = await svc.assignAllOpenCases();
      expect(results).toHaveLength(0);
    });
  });

  // ── getReviewerCapacities ─────────────────────────────────────────────────

  describe('getReviewerCapacities', () => {
    it('returns capacity snapshots for all reviewers', async () => {
      const rows = [
        [
          { assigned_to: 'r1', active_count: 4 },
          { assigned_to: 'r2', active_count: 1 },
        ],
        [
          { assigned_to: 'r1', last_closed_at: daysAgo(0) },
        ],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(
        pool,
        metrics,
        [makeProfile('r1', 10, 24), makeProfile('r2', 5, 12)],
      );

      const caps = await svc.getReviewerCapacities();

      expect(caps).toHaveLength(2);
      const r1 = caps.find((c) => c.reviewer_id === 'r1')!;
      const r2 = caps.find((c) => c.reviewer_id === 'r2')!;

      expect(r1.active_cases).toBe(4);
      expect(r1.remaining_capacity).toBe(6);
      expect(r1.in_cool_down).toBe(true); // closed < 24h ago
      expect(r1.eligible).toBe(false);

      expect(r2.active_cases).toBe(1);
      expect(r2.remaining_capacity).toBe(4);
      expect(r2.in_cool_down).toBe(false);
      expect(r2.eligible).toBe(true);
    });

    it('returns empty array when no reviewers configured', async () => {
      const pool = makePool([[], []]);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, []);

      const caps = await svc.getReviewerCapacities();
      expect(caps).toHaveLength(0);
    });

    it('marks reviewer eligible when capacity is available and not in cool-down', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 2 }],
        [], // no close history
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].eligible).toBe(true);
      expect(caps[0].in_cool_down).toBe(false);
    });

    it('marks reviewer ineligible when at max capacity', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 10 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].eligible).toBe(false);
      expect(caps[0].remaining_capacity).toBe(0);
    });

    it('marks reviewer ineligible when in cool-down', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 0 }],
        [{ assigned_to: 'r1', last_closed_at: daysAgo(0) }],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10, 48)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].eligible).toBe(false);
      expect(caps[0].in_cool_down).toBe(true);
    });

    it('handles reviewers with no close history', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 3 }],
        [], // no close history
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].last_closed_at).toBeNull();
      expect(caps[0].in_cool_down).toBe(false);
      expect(caps[0].eligible).toBe(true);
    });

    it('caps remaining_capacity at zero (never negative)', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 15 }], // more than max
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].remaining_capacity).toBe(0);
    });
  });

  // ── cool-down edge cases ──────────────────────────────────────────────────

  describe('cool-down edge cases', () => {
    it('reviewer becomes eligible after cool-down expires', async () => {
      // Simulate: reviewer closed a case 25 hours ago with a 24h cool-down
      const d = new Date();
      d.setHours(d.getHours() - 25);
      const rows = [
        [{ assigned_to: 'r1', active_count: 0 }],
        [{ assigned_to: 'r1', last_closed_at: d.toISOString() }],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10, 24)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].in_cool_down).toBe(false);
      expect(caps[0].eligible).toBe(true);
    });

    it('reviewer with zero cool-down is always eligible if capacity exists', async () => {
      const rows = [
        [{ assigned_to: 'r1', active_count: 0 }],
        [{ assigned_to: 'r1', last_closed_at: daysAgo(0) }], // closed just now
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1', 10, 0)]);

      const caps = await svc.getReviewerCapacities();
      expect(caps[0].in_cool_down).toBe(false);
      expect(caps[0].eligible).toBe(true);
    });
  });

  // ── age-days histogram ────────────────────────────────────────────────────

  describe('age-days histogram', () => {
    it('emits age_days=0 for a case created today', async () => {
      const now = new Date();
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: now.toISOString() }],
        [{ assigned_to: 'r1', active_count: 0 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const result = await svc.assignCase('c1');
      expect(result.age_days).toBe(0);
    });

    it('emits correct age_days for a case created 30 days ago', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: ['a1'], investor_id: 'inv1', status: 'open', created_at: daysAgo(30) }],
        [{ assigned_to: 'r1', active_count: 0 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const result = await svc.assignCase('c1');
      expect(result.age_days).toBe(30);
    });
  });

  // ── constructor with no profiles ──────────────────────────────────────────

  describe('no profiles configured', () => {
    it('assignAllOpenCases returns empty without querying', async () => {
      const rows = [
        [{ id: 'c1', alert_ids: [], investor_id: 'i1', status: 'open', created_at: daysAgo(1) }],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, []);

      const results = await svc.assignAllOpenCases();
      expect(results).toHaveLength(0);
    });
  });

  // ── Postgres row shape variations ─────────────────────────────────────────

  describe('Postgres row shape variations', () => {
    it('handles alert_ids returned as JSON string from Postgres', async () => {
      const rows = [
        [
          {
            id: 'c1',
            alert_ids: '["a1","a2"]',
            investor_id: 'inv1',
            status: 'open',
            created_at: daysAgo(3),
          },
        ],
        [{ assigned_to: 'r1', active_count: 0 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const result = await svc.assignCase('c1');
      expect(result.case_id).toBe('c1');
    });

    it('handles closed_at present on row returned by fetchOpenCase', async () => {
      const rows = [
        [
          {
            id: 'c1',
            alert_ids: ['a1'],
            investor_id: 'inv1',
            status: 'open',
            created_at: daysAgo(1),
            closed_at: daysAgo(0),
            assigned_to: null,
            disposition: null,
            notes: null,
          },
        ],
        [{ assigned_to: 'r1', active_count: 0 }],
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const result = await svc.assignCase('c1');
      expect(result.case_id).toBe('c1');
    });

    it('handles alert_ids as JSON string and closed_at on fetchAllOpenCases', async () => {
      const rows = [
        [
          {
            id: 'c1',
            alert_ids: '["a1"]',
            investor_id: 'i1',
            status: 'open',
            created_at: daysAgo(1),
            closed_at: daysAgo(0),
            assigned_to: null,
            disposition: null,
            notes: null,
          },
        ],
        // fetchOpenCase
        [
          {
            id: 'c1',
            alert_ids: '["a1"]',
            investor_id: 'i1',
            status: 'open',
            created_at: daysAgo(1),
            closed_at: daysAgo(0),
            assigned_to: null,
            disposition: null,
            notes: null,
          },
        ],
        // count query
        [{ assigned_to: 'r1', active_count: 0 }],
        // close query
        [],
        // UPDATE
        [],
      ];
      const pool = makePool(rows);
      const metrics = makeMetrics();
      const svc = new CaseAssignmentService(pool, metrics, [makeProfile('r1')]);

      const results = await svc.assignAllOpenCases();
      expect(results).toHaveLength(1);
    });
  });
});
