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
  | 'velocity'           // High transaction frequency/amount in time window
  | 'structuring'        // Breaking large transactions into smaller ones
  | 'geo_mismatch'       // Geographic inconsistency in transactions
  | 'amount_threshold'   // Single transaction exceeds threshold
  | 'sanctions_screening'; // Sanctions list screening (exact & Jaro-Winkler fuzzy)

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
