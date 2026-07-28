/**
 * AML Case Assignment Service
 *
 * Capacity-aware load balancer that assigns open AML cases to reviewers
 * based on:
 *   - Current utilization (active case count vs. max capacity)
 *   - Cool-down enforcement after a case decision (close / dismiss)
 *   - Case-age SLO histogram emission on every assignment
 *
 * Reviewer profiles are supplied by the caller (no DB table for profiles);
 * capacity is derived from the live `aml_cases` table.
 *
 * Security assumptions:
 *   - The caller (typically an admin endpoint) is responsible for
 *     authorising which reviewer IDs are valid.  This service trusts
 *     the `eligibleReviewerIds` list passed in at construction time.
 *   - Cool-down and capacity are computed from real DB state, so a
 *     reviewer cannot bypass limits by manipulating in-memory state.
 *
 * @module aml/caseAssignmentService
 */

import { Pool } from 'pg';
import { MetricsCollector } from '../lib/metrics';
import { globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import {
  AMLCase,
  ReviewerProfile,
  ReviewerCapacity,
  AssignmentResult,
} from './types';

const logger = globalLogger.child({ service: 'aml-case-assignment' });

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CAPACITY = 10;
const DEFAULT_COOL_DOWN_HOURS = 24;

// ── Service ──────────────────────────────────────────────────────────────────

export class CaseAssignmentService {
  /**
   * @param db           Postgres connection pool
   * @param metrics      Metrics collector for histogram emission
   * @param profiles     Reviewer profiles (id, max_capacity, cool_down_hours)
   */
  constructor(
    private readonly db: Pool,
    private readonly metrics: MetricsCollector,
    private readonly profiles: ReviewerProfile[],
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Auto-assign a single open case to the least-loaded eligible reviewer.
   *
   * @param caseId  The `aml_cases.id` to assign (must be in `open` status).
   * @returns The assignment result with case-age metric emitted.
   * @throws NOT_FOUND if the case does not exist or is not open.
   * @throws CONFLICT  if no reviewer is eligible.
   */
  async assignCase(caseId: string): Promise<AssignmentResult> {
    const amlCase = await this.fetchOpenCase(caseId);
    const ageDays = this.computeAgeDays(amlCase.created_at);

    const capacities = await this.computeAllCapacities();
    const eligible = capacities.filter((c) => c.eligible);

    if (eligible.length === 0) {
      throw Errors.conflict(
        'No eligible reviewer available for assignment',
        { case_id: caseId, reviewer_count: capacities.length },
      );
    }

    // Least-loaded reviewer (highest remaining capacity, tie-break by reviewer_id)
    eligible.sort((a, b) =>
      b.remaining_capacity - a.remaining_capacity || a.reviewer_id.localeCompare(b.reviewer_id),
    );
    const winner = eligible[0];

    await this.db.query(
      `UPDATE aml_cases
          SET assigned_to = $1,
              status      = 'assigned',
              updated_at  = NOW()
        WHERE id = $2`,
      [winner.reviewer_id, caseId],
    );

    // Emit case-age SLO histogram
    this.metrics.recordHistogram(
      'aml.case.age_days',
      ageDays,
      { severity: 'all' },
      'Age of AML case in days at time of assignment',
    );

    logger.info('AML case auto-assigned', {
      case_id: caseId,
      assigned_to: winner.reviewer_id,
      age_days: ageDays,
    });

    return {
      case_id: caseId,
      assigned_to: winner.reviewer_id,
      age_days: ageDays,
      reviewer_capacities: capacities,
    };
  }

  /**
   * Auto-assign all unassigned open cases (batch mode).
   *
   * Cases are processed oldest-first.  If at any point no reviewer is
   * eligible the remaining cases are skipped (no error thrown for the batch).
   *
   * @returns Array of successful assignments.
   */
  async assignAllOpenCases(): Promise<AssignmentResult[]> {
    const openCases = await this.fetchAllOpenCases();

    // Sort oldest first
    openCases.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const results: AssignmentResult[] = [];

    for (const c of openCases) {
      try {
        const result = await this.assignCase(c.id);
        results.push(result);
      } catch {
        // No eligible reviewer — stop assigning further cases
        break;
      }
    }

    return results;
  }

  /**
   * Get capacity snapshot for all configured reviewers.
   */
  async getReviewerCapacities(): Promise<ReviewerCapacity[]> {
    return this.computeAllCapacities();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async fetchOpenCase(caseId: string): Promise<AMLCase> {
    const result = await this.db.query(
      `SELECT * FROM aml_cases WHERE id = $1`,
      [caseId],
    );

    if (result.rows.length === 0) {
      throw Errors.notFound(`AML case '${caseId}' not found`);
    }

    const amlCase = result.rows[0];
    if (amlCase.status !== 'open') {
      throw Errors.conflict(
        `Case '${caseId}' has status '${amlCase.status as string}' — only 'open' cases can be auto-assigned`,
      );
    }

    return {
      id: amlCase.id,
      alert_ids: typeof amlCase.alert_ids === 'string' ? JSON.parse(amlCase.alert_ids) : amlCase.alert_ids,
      investor_id: amlCase.investor_id,
      status: amlCase.status,
      assigned_to: amlCase.assigned_to ?? undefined,
      disposition: amlCase.disposition ?? undefined,
      notes: amlCase.notes ?? undefined,
      created_at: new Date(amlCase.created_at),
      updated_at: new Date(amlCase.updated_at),
      closed_at: amlCase.closed_at ? new Date(amlCase.closed_at) : undefined,
    };
  }

  private async fetchAllOpenCases(): Promise<AMLCase[]> {
    const result = await this.db.query(
      `SELECT * FROM aml_cases WHERE status = 'open' AND assigned_to IS NULL ORDER BY created_at ASC`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      alert_ids: typeof row.alert_ids === 'string' ? JSON.parse(row.alert_ids) : row.alert_ids,
      investor_id: row.investor_id,
      status: row.status,
      assigned_to: row.assigned_to ?? undefined,
      disposition: row.disposition ?? undefined,
      notes: row.notes ?? undefined,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      closed_at: row.closed_at ? new Date(row.closed_at) : undefined,
    }));
  }

  /**
   * Compute the age of a case in whole days (rounded down).
   */
  private computeAgeDays(createdAt: Date): number {
    const now = Date.now();
    const created = new Date(createdAt).getTime();
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.floor((now - created) / msPerDay);
  }

  /**
   * Build capacity snapshots for every configured reviewer.
   */
  private async computeAllCapacities(): Promise<ReviewerCapacity[]> {
    // Batch-query active case counts and last-close timestamps
    const reviewerIds = this.profiles.map((p) => p.reviewer_id);
    if (reviewerIds.length === 0) return [];

    const countResult = await this.db.query(
      `SELECT assigned_to, COUNT(*)::int AS active_count
         FROM aml_cases
        WHERE assigned_to = ANY($1)
          AND status IN ('assigned', 'investigating')
        GROUP BY assigned_to`,
      [reviewerIds],
    );

    const activeMap = new Map<string, number>();
    for (const row of countResult.rows) {
      activeMap.set(row.assigned_to as string, row.active_count as number);
    }

    // Find the most recent closed/dismissed case per reviewer
    const closeResult = await this.db.query(
      `SELECT assigned_to, MAX(closed_at) AS last_closed_at
         FROM aml_cases
        WHERE assigned_to = ANY($1)
          AND closed_at IS NOT NULL
        GROUP BY assigned_to`,
      [reviewerIds],
    );

    const lastCloseMap = new Map<string, Date | null>();
    for (const row of closeResult.rows) {
      lastCloseMap.set(row.assigned_to as string, new Date(row.last_closed_at as string));
    }

    const now = Date.now();
    const capacities: ReviewerCapacity[] = [];

    for (const profile of this.profiles) {
      const activeCases = activeMap.get(profile.reviewer_id) ?? 0;
      const remaining = Math.max(0, profile.max_capacity - activeCases);
      const lastClosed = lastCloseMap.get(profile.reviewer_id) ?? null;

      const coolDownMs = profile.cool_down_hours * 60 * 60 * 1000;
      const inCoolDown =
        lastClosed !== null && now - lastClosed.getTime() < coolDownMs;

      const eligible = remaining > 0 && !inCoolDown;

      capacities.push({
        reviewer_id: profile.reviewer_id,
        active_cases: activeCases,
        max_capacity: profile.max_capacity,
        remaining_capacity: remaining,
        last_closed_at: lastClosed ? lastClosed.toISOString() : null,
        in_cool_down: inCoolDown,
        eligible,
      });
    }

    return capacities;
  }
}
