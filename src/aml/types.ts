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
  | 'velocity'                   // High transaction frequency/amount in time window
  | 'structuring'                // Breaking large transactions into smaller ones
  | 'geo_mismatch'               // Geographic inconsistency in transactions
  | 'amount_threshold'           // Single transaction exceeds threshold
  | 'sanctions_screening'        // Sanctions list screening — person queue (exact & Jaro-Winkler fuzzy)
  | 'ofac_counterparty_screening'; // OFAC screening for non-person counterparty metadata (vessels, aircraft, organisations)

/**
 * OFAC entity taxonomy — covers the four entity classes that appear on the
 * OFAC SDN list as counterparty metadata on investment offerings.
 *
 * @see https://ofac.treasury.gov/faqs/topic/1521
 */
export type OfacEntityType = 'person' | 'vessel' | 'aircraft' | 'organisation';

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
  match_type: 'exact' | 'fuzzy';
  /**
   * Human-readable match reason recorded on the alert, e.g.
   * 'ofac_vessel_exact', 'ofac_aircraft_fuzzy', 'ofac_organisation_exact'.
   * Format: `ofac_<entity_type>_<match_type>`.
   */
  match_reason: string;
  /** Analyst action: 'auto_deny' (exact match) or 'pending_review' (fuzzy). */
  action: 'auto_deny' | 'pending_review';
}

/**
 * Rule severity levels for prioritization
 */
export type AMLSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Case workflow statuses
 */
export type AMLCaseStatus = 'open' | 'assigned' | 'investigating' | 'closed' | 'dismissed';

/**
 * Case disposition outcomes
 */
export type AMLDisposition = 'confirmed_suspicious' | 'false_positive' | 'inconclusive' | 'legitimate';

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
  status?: 'pending' | 'completed' | 'failed';
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
  status: 'pending' | 'reviewed' | 'dismissed';
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
  upsert(record: Omit<InvestmentVelocityRecord, 'id' | 'created_at' | 'updated_at'>): Promise<InvestmentVelocityRecord>;

  /**
   * Return all velocity records for an investor within the given time range,
   * ordered by window_end descending.
   */
  findByInvestor(investorId: string, from: Date, to: Date): Promise<InvestmentVelocityRecord[]>;
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
