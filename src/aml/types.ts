/**
 * AML Transaction Monitoring Types
 *
 * Provides type-safe interfaces for AML rule definitions,
 * evaluation context, and case management workflow.
 */

/**
 * AML Rule Types - supported detection patterns
 */
export type AMLRuleType =
  | "velocity" // High transaction frequency/amount in time window
  | "structuring" // Breaking large transactions into smaller ones
  | "geo_mismatch" // Geographic inconsistency in transactions
  | "amount_threshold" // Single transaction exceeds threshold
  | "sanctions_screening" // Sanctions list screening — person queue (exact & Jaro-Winkler fuzzy)
  | "ofac_counterparty_screening"; // OFAC screening for non-person counterparty metadata (vessels, aircraft, organisations)

/**
 * OFAC entity taxonomy — covers the four entity classes that appear on the
 * OFAC SDN list as counterparty metadata on investment offerings.
 *
 * @see https://ofac.treasury.gov/faqs/topic/1521
 */
export type OfacEntityType = "person" | "vessel" | "aircraft" | "organisation";

/**
 * A single counterparty attached to an offering that must be screened against
 * the OFAC SDN / vessel / aircraft lists.
 *
 * @property name        - Legal or registered name of the counterparty.
 * @property type        - Entity class; controls which OFAC sub-list is searched.
 * @property imo_number  - IMO vessel/ship identification number (format: `IMO` + 7 digits).
 *                         Only applicable when type === 'vessel'. Validated by the evaluator;
 *                         forged or malformed values are silently dropped from alert details.
 */
export interface OfacCounterparty {
  name: string;
  type: OfacEntityType;
  imo_number?: string;
}

/**
 * Structured match evidence recorded per counterparty hit in the alert details.
 * An array of these (`matches`) is emitted under `RuleEvaluationResult.details`
 * so analysts can trace exactly which counterparty triggered the rule and why.
 */
export interface OfacScreeningMatch {
  /** Name that was screened. */
  screened_name: string;
  /** Entity class of the counterparty. */
  entity_type: OfacEntityType;
  /** Validated IMO number, present only for vessels with a valid format. */
  imo_number?: string;
  /** Best-matching OFAC list entry. */
  matched_candidate: string;
  /** Jaro-Winkler similarity or 1.0 for exact matches. */
  similarity_score: number;
  /** 'exact' = normalised string equality; 'fuzzy' = Jaro-Winkler above threshold. */
  match_type: "exact" | "fuzzy";
  /**
   * Human-readable match reason recorded on the alert, e.g.
   * 'ofac_vessel_exact', 'ofac_aircraft_fuzzy', 'ofac_organisation_exact'.
   * Format: `ofac_<entity_type>_<match_type>`.
   */
  match_reason: string;
  /** Analyst action: 'auto_deny' (exact match) or 'pending_review' (fuzzy). */
  action: "auto_deny" | "pending_review";
}

/**
 * Rule severity levels for prioritization
 */
export type AMLSeverity = "low" | "medium" | "high" | "critical";

/**
 * Case workflow statuses
 */
export type AMLCaseStatus =
  "open" | "assigned" | "investigating" | "closed" | "dismissed";

/**
 * Case disposition outcomes
 */
export type AMLDisposition =
  "confirmed_suspicious" | "false_positive" | "inconclusive" | "legitimate";

/**
 * Semver version for rule versioning
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * AML Rule definition with versioning
 */
export interface AMLRule {
  id: string;
  name: string;
  description: string;
  type: AMLRuleType;
  version: SemVer;
  severity: AMLSeverity;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Transaction context for rule evaluation
 */
export interface TransactionContext {
  investment_id: string;
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
  timestamp: Date;
  investor_name?: string;
  investor_country?: string;
  investor_ip_country?: string;
  previous_transactions?: TransactionContext[];
  status?: "pending" | "completed" | "failed" | "refunded";
  tenant_id?: string;
  tenant_settings?: {
    sanctions_threshold?: number;
    [key: string]: unknown;
  };
  /**
   * Non-person counterparties attached to the offering being invested in.
   * Each entry is independently screened by the `ofac_counterparty_screening` rule.
   * Person-type entries in this array do NOT feed the person-queue sanctions rule
   * to prevent cross-type false-positive noise.
   */
  counterparties?: OfacCounterparty[];
}

/**
 * Sanctions rule configuration schema
 */
export interface SanctionsRuleConfig {
  sanctions_list: string[];
  jaro_winkler_threshold?: number;
  fuzzy_enabled?: boolean;
}

/**
 * Configuration for the `ofac_counterparty_screening` rule.
 * Extends the base sanctions config with an optional entity-type filter so a
 * single rule can be scoped to, e.g., vessels only.
 *
 * @property entity_types - When supplied, only counterparties whose `type` is
 *                          in this array are screened. Defaults to all types.
 */
export interface OfacVesselAircraftRuleConfig extends SanctionsRuleConfig {
  /**
   * Restrict screening to these entity types.
   * Omit (or set to undefined) to screen all entity types.
   */
  entity_types?: OfacEntityType[];
}

/**
 * Rule evaluation result
 */
export interface RuleEvaluationResult {
  rule_id: string;
  rule_version: SemVer;
  triggered: boolean;
  severity: AMLSeverity;
  details: Record<string, unknown>;
  timestamp: Date;
}

/**
 * AML Alert - generated when rules trigger
 */
export interface AMLAlert {
  id: string;
  investment_id: string;
  investor_id: string;
  rule_id: string;
  rule_version: SemVer;
  severity: AMLSeverity;
  details: Record<string, unknown>;
  status: "pending" | "reviewed" | "dismissed";
  case_id?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * AML Case for analyst workflow
 */
export interface AMLCase {
  id: string;
  alert_ids: string[];
  investor_id: string;
  status: AMLCaseStatus;
  assigned_to?: string; // analyst user ID
  disposition?: AMLDisposition;
  notes?: string;
  created_at: Date;
  updated_at: Date;
  closed_at?: Date;
}

/**
 * Rule version history entry
 */
export interface RuleVersionHistory {
  id: string;
  rule_id: string;
  version: SemVer;
  config: Record<string, unknown>;
  enabled: boolean;
  changed_by: string; // user ID who made the change
  change_reason: string;
  created_at: Date;
}

/**
 * Rule evaluation statistics
 */
export interface RuleEvaluationStats {
  rule_id: string;
  total_evaluations: number;
  triggers: number;
  false_positives: number;
  confirmed_suspicious: number;
  last_triggered_at?: Date;
}

/**
 * Input for creating a new rule
 */
export interface CreateRuleInput {
  name: string;
  description: string;
  type: AMLRuleType;
  severity: AMLSeverity;
  config: Record<string, unknown>;
}

/**
 * Input for updating an existing rule
 */
export interface UpdateRuleInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  change_reason: string;
}

/**
 * Input for creating a case
 */
export interface CreateCaseInput {
  alert_ids: string[];
  investor_id: string;
  assigned_to?: string;
  notes?: string;
}

/**
 * Input for updating a case
 */
export interface UpdateCaseInput {
  status?: AMLCaseStatus;
  assigned_to?: string;
  disposition?: AMLDisposition;
  notes?: string;
}

/**
 * Configuration for structuring detection rule with amount-clustering heuristic.
 * Stored in AMLRule.config for rules of type 'structuring'.
 */
export interface StructuringDetectionRuleConfig {
  /** Rolling window length in days (e.g. 30 days). Defaults to 30 if window_hours is omitted. */
  window_days?: number;
  /** Rolling window length in hours (optional alternate unit). */
  window_hours?: number;
  /** Primary regulatory reporting threshold (e.g. 10000 for USD). Defaults to 10000. */
  reporting_threshold?: number;
  /** Lower ratio for near-threshold cluster band (e.g. 0.8 -> $8,000 for $10,000 threshold). Defaults to 0.8. */
  cluster_lower_ratio?: number;
  /** Upper ratio for near-threshold cluster band (e.g. 0.999 -> $9,999.99 for $10,000 threshold). Defaults to 0.999. */
  cluster_upper_ratio?: number;
  /** Minimum number of transactions in cluster band required to trigger alert. Defaults to 2. */
  min_cluster_count?: number;
  /** Score threshold (0-100) above which rule triggers alert. Defaults to 50. */
  score_threshold?: number;
  /** Jurisdiction identifier for jurisdiction-aware reporting thresholds (e.g. 'US', 'EU', 'JP'). Defaults to 'US'. */
  jurisdiction?: string;
  /** Optional dictionary of jurisdiction-specific reporting thresholds. */
  jurisdiction_thresholds?: Record<string, number>;
  /** Minimum transaction amount filter for similar transaction check (fallback). */
  amount_threshold?: number;
  /** Minimum transaction count filter (fallback). */
  min_transactions?: number;
}

/**
 * Single bucket in the deposit amount histogram.
 */
export interface StructuringHistogramBucket {
  label: string;
  min_amount: number;
  max_amount: number;
  count: number;
  total_amount: number;
}

/**
 * Result of deposit histogram clustering evaluation.
 */
export interface StructuringClusterResult {
  cluster_score: number;
  score_threshold: number;
  clustered_count: number;
  clustered_total_amount: number;
  total_deposits_count: number;
  total_deposits_amount: number;
  reporting_threshold: number;
  jurisdiction: string;
  histogram_buckets: StructuringHistogramBucket[];
  linked_investment_ids: string[];
}

/**
 * Configuration for the sliding-window investment velocity rule.
 * Stored in AMLRule.config for rules of type 'velocity'.
 */
export interface VelocityRuleConfig {
  /** Rolling window length in minutes. */
  window_minutes: number;
  /** Maximum aggregate invested amount in the window before triggering. */
  max_amount: number;
  /** Maximum number of investments in the window before triggering. */
  max_count: number;
}

/**
 * A single row persisted to aml_investment_velocity for audit purposes.
 */
export interface InvestmentVelocityRecord {
  id: string;
  investor_id: string;
  window_start: Date;
  window_end: Date;
  window_minutes: number;
  tx_count: number;
  total_amount: number;
  investment_ids: string[];
  amount_exceeded: boolean;
  count_exceeded: boolean;
  threshold_amount: number | null;
  threshold_count: number | null;
  rule_id: string;
  rule_version: SemVer;
  created_at: Date;
  updated_at: Date;
}

/**
 * Repository interface for persisting velocity aggregate rows.
 * The in-process evaluator uses an InMemoryVelocityRepository; production
 * code wires in a PgVelocityRepository backed by aml_investment_velocity.
 */
export interface VelocityRepository {
  /**
   * Upsert a velocity aggregate row.
   * On conflict (investor_id, window_start, window_end, rule_id) the row is
   * updated in-place so late-arriving events shift the window without
   * duplicating records.
   */
  upsert(
    record: Omit<InvestmentVelocityRecord, "id" | "created_at" | "updated_at">,
  ): Promise<InvestmentVelocityRecord>;

  /**
   * Return all velocity records for an investor within the given time range,
   * ordered by window_end descending.
   */
  findByInvestor(
    investorId: string,
    from: Date,
    to: Date,
  ): Promise<InvestmentVelocityRecord[]>;
}

/**
 * Reviewer profile for load-balancer capacity tracking
 */
export interface ReviewerProfile {
  /** Reviewer user ID. */
  reviewer_id: string;
  /** Maximum concurrent open cases this reviewer may hold. */
  max_capacity: number;
  /** Minimum hours after closing a case before the reviewer is eligible again. */
  cool_down_hours: number;
}

/**
 * Reviewer capacity snapshot (computed at assignment time)
 */
export interface ReviewerCapacity {
  reviewer_id: string;
  active_cases: number;
  max_capacity: number;
  remaining_capacity: number;
  /** ISO-8601 timestamp of the reviewer's most recent case closure, or null. */
  last_closed_at: string | null;
  /** Whether the reviewer is currently in cool-down. */
  in_cool_down: boolean;
  /** Whether the reviewer is eligible for a new assignment. */
  eligible: boolean;
}

/**
 * Result of an auto-assignment attempt
 */
export interface AssignmentResult {
  /** The case that was assigned. */
  case_id: string;
  /** The reviewer who received the assignment. */
  assigned_to: string;
  /** Age of the case in days at assignment time. */
  age_days: number;
  /** Snapshot of all reviewer capacities at the time of assignment. */
  reviewer_capacities: ReviewerCapacity[];
}

// ── OFAC dual-control review queue ────────────────────────────────────────────

/**
 * Workflow status of an OFAC false-positive review.
 *
 * - `pending_first_approval`  – newly created; awaiting first compliance officer.
 * - `pending_second_approval` – first approval recorded; awaiting a second,
 *                               independent compliance officer.
 * - `cleared`                 – both approvals recorded; investor may proceed.
 * - `expired`                 – review window elapsed without being fully cleared
 *                               (set by a background sweep; row re-enters queue as
 *                               `pending_first_approval` on next `findQueue` call).
 * - `rejected`                – manually rejected by a compliance officer.
 */
export type OFACReviewStatus =
  | "pending_first_approval"
  | "pending_second_approval"
  | "cleared"
  | "expired"
  | "rejected";

/**
 * A persisted OFAC false-positive review case.
 *
 * Two independent compliance officers must approve the clearance; the second
 * approver must differ from both the case creator and the first approver.
 * All state transitions are mirrored as immutable security audit events by
 * `AMLService`.
 */
export interface OFACReview {
  /** Unique review ID (e.g. `ofac_review_<timestamp>_<random>`). */
  id: string;
  /** AML alert that triggered this review. */
  alert_id: string;
  /** Optional AML case the alert belongs to. */
  case_id?: string;
  /** Investor who was flagged. */
  investor_id: string;
  /** The OFAC list entry name that collided with the investor name. */
  matched_name: string;
  /** Optional OFAC SDN list entry identifier for traceability. */
  list_entry_id?: string;
  /** Current workflow status. */
  status: OFACReviewStatus;
  /** User ID of the compliance officer who opened the review. */
  created_by: string;
  created_at: Date;
  /** User ID of the first approving compliance officer. */
  first_approver_id?: string;
  /** Rationale recorded by the first approver. */
  first_approval_rationale?: string;
  first_approved_at?: Date;
  /** User ID of the second approving compliance officer. */
  second_approver_id?: string;
  /** Rationale recorded by the second approver. */
  second_approval_rationale?: string;
  second_approved_at?: Date;
  /**
   * Combined clearance narrative: original creator rationale + first approver
   * statement + second approver statement, joined by newlines.
   */
  clearance_rationale?: string;
  cleared_at?: Date;
  /**
   * ISO-8601 datetime after which a `pending_second_approval` review that has
   * not been fully cleared is reset to `pending_first_approval` so that the
   * dual-control window cannot be gamed by waiting indefinitely.
   */
  expires_at: Date;
  updated_at: Date;
}

/**
 * Input required to open a new OFAC false-positive review.
 */
export interface CreateOFACReviewInput {
  /** AML alert that triggered the review. */
  alert_id: string;
  /** Optional AML case the alert belongs to. */
  case_id?: string;
  /** Investor flagged by the OFAC screen. */
  investor_id: string;
  /** The OFAC list entry name that collided with the investor name. */
  matched_name: string;
  /** Optional OFAC SDN list entry identifier. */
  list_entry_id?: string;
  /**
   * Initial rationale provided by the creator explaining why this is a
   * false positive (minimum 10 characters).
   */
  rationale: string;
  /**
   * Optional override for the review expiry window. Defaults to 24 hours
   * from creation.
   */
  expires_at?: Date;
}
