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
  | 'amount_threshold';  // Single transaction exceeds threshold

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
  investor_country?: string;
  investor_ip_country?: string;
  previous_transactions?: TransactionContext[];
  status?: 'pending' | 'completed' | 'failed';
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

export type OFACReviewStatus =
  | 'pending_first_approval'
  | 'pending_second_approval'
  | 'cleared'
  | 'expired'
  | 'rejected';

export interface OFACReview {
  id: string;
  alert_id: string;
  case_id?: string;
  investor_id: string;
  matched_name: string;
  list_entry_id?: string;
  status: OFACReviewStatus;
  created_by: string;
  created_at: Date;
  first_approver_id?: string;
  first_approval_rationale?: string;
  first_approved_at?: Date;
  second_approver_id?: string;
  second_approval_rationale?: string;
  second_approved_at?: Date;
  clearance_rationale?: string;
  cleared_at?: Date;
  expires_at: Date;
  updated_at: Date;
}

export interface CreateOFACReviewInput {
  alert_id: string;
  case_id?: string;
  investor_id: string;
  matched_name: string;
  list_entry_id?: string;
  rationale: string;
  expires_at?: Date;
}
