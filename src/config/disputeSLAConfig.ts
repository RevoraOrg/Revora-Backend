/**
 * Dispute SLA Configuration
 *
 * SLA durations are configured per jurisdiction and dispute state.
 * These durations represent the maximum allowable time (in hours) a dispute
 * can remain in a given state before triggering an automatic escalation.
 *
 * Security assumptions:
 * - Durations are validated to be positive integers
 * - Unknown jurisdictions fall back to a 'default' tier
 * - Unknown states fall back to the longest duration for that jurisdiction
 */

/** Dispute states tracked by SLA timers */
export const DISPUTE_STATES = [
  'new',
  'triage',
  'investigating',
  'awaiting_customer',
  'awaiting_merchant',
  'awaiting_evidence',
  'under_review',
  'resolution_proposed',
  'escalated_internal',
  'resolved',
  'closed',
] as const;

export type DisputeState = (typeof DISPUTE_STATES)[number];

/** Recognised jurisdictions */
export const DISPUTE_JURISDICTIONS = [
  'US',
  'EU',
  'UK',
  'CA',
  'AU',
  'SG',
  'default',
] as const;

export type DisputeJurisdiction = (typeof DISPUTE_JURISDICTIONS)[number];

/**
 * SLA durations in hours per jurisdiction per dispute state.
 *
 * Regulatory guidance:
 * - US (Reg E / Reg Z): 10 business days acknowledge, 90 days resolve
 * - EU (PSD2): 15 business days, extendable to 35
 * - UK (FCA): similar to EU, 15 business days
 * - CA (FCAC): 56 calendar days for most disputes
 * - AU (AFCA): 30 calendar days for standard complaints
 * - SG (MAS): 20 business days for standard cases
 */
export interface JurisdictionSLAConfig {
  jurisdiction: DisputeJurisdiction;
  /** SLA durations in hours per dispute state */
  stateSLAs: Record<DisputeState, number>;
  /** Escalation contacts for when SLA is breached */
  escalationContacts?: string[];
  /** Whether auto-escalation is enabled for this jurisdiction */
  autoEscalate: boolean;
}

const DEFAULT_STATE_SLAS: Record<DisputeState, number> = {
  new: 4,
  triage: 8,
  investigating: 72,
  awaiting_customer: 120,
  awaiting_merchant: 72,
  awaiting_evidence: 96,
  under_review: 48,
  resolution_proposed: 24,
  escalated_internal: 24,
  resolved: 0,
  closed: 0,
};

/**
 * Per-jurisdiction SLA configurations.
 * Each jurisdiction can override the default durations.
 */
export const JURISDICTION_SLA_CONFIGS: Record<DisputeJurisdiction, JurisdictionSLAConfig> = {
  US: {
    jurisdiction: 'US',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 4,
      triage: 8,
      investigating: 72,
      awaiting_customer: 240, // 10 business days ~ 240 hours
      awaiting_merchant: 120,
      awaiting_evidence: 168,
      under_review: 72,
      resolution_proposed: 48,
    },
    escalationContacts: ['compliance-us@revora.com'],
    autoEscalate: true,
  },
  EU: {
    jurisdiction: 'EU',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 4,
      triage: 8,
      investigating: 48,
      awaiting_customer: 360, // 15 business days ~ 360 hours
      awaiting_merchant: 72,
      awaiting_evidence: 120,
      under_review: 48,
      resolution_proposed: 48,
    },
    escalationContacts: ['compliance-eu@revora.com'],
    autoEscalate: true,
  },
  UK: {
    jurisdiction: 'UK',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 4,
      triage: 8,
      investigating: 48,
      awaiting_customer: 360, // 15 business days
      awaiting_merchant: 72,
      awaiting_evidence: 120,
      under_review: 48,
      resolution_proposed: 48,
    },
    escalationContacts: ['compliance-uk@revora.com'],
    autoEscalate: true,
  },
  CA: {
    jurisdiction: 'CA',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 8,
      triage: 16,
      investigating: 120,
      awaiting_customer: 1344, // 56 calendar days
      awaiting_merchant: 168,
      awaiting_evidence: 240,
      under_review: 96,
      resolution_proposed: 72,
    },
    escalationContacts: ['compliance-ca@revora.com'],
    autoEscalate: true,
  },
  AU: {
    jurisdiction: 'AU',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 8,
      triage: 16,
      investigating: 96,
      awaiting_customer: 720, // 30 calendar days
      awaiting_merchant: 120,
      awaiting_evidence: 168,
      under_review: 72,
      resolution_proposed: 48,
    },
    escalationContacts: ['compliance-au@revora.com'],
    autoEscalate: true,
  },
  SG: {
    jurisdiction: 'SG',
    stateSLAs: {
      ...DEFAULT_STATE_SLAS,
      new: 4,
      triage: 8,
      investigating: 48,
      awaiting_customer: 480, // 20 business days
      awaiting_merchant: 96,
      awaiting_evidence: 144,
      under_review: 48,
      resolution_proposed: 48,
    },
    escalationContacts: ['compliance-sg@revora.com'],
    autoEscalate: true,
  },
  default: {
    jurisdiction: 'default',
    stateSLAs: { ...DEFAULT_STATE_SLAS },
    escalationContacts: ['compliance@revora.com'],
    autoEscalate: false,
  },
};

/**
 * Get the SLA duration in hours for a given jurisdiction and dispute state.
 * Falls back to 'default' jurisdiction if the requested one is not found.
 *
 * @param jurisdiction - The jurisdiction key
 * @param state - The dispute state
 * @returns SLA duration in hours
 */
export function getSLADuration(
  jurisdiction: string,
  state: string,
): number {
  const config =
    JURISDICTION_SLA_CONFIGS[jurisdiction as DisputeJurisdiction] ??
    JURISDICTION_SLA_CONFIGS.default;

  const duration = config.stateSLAs[state as DisputeState];

  if (duration !== undefined && duration >= 0) {
    return duration;
  }

  // Fallback: return the max duration configured for this jurisdiction
  const durations = Object.values(config.stateSLAs);
  return Math.max(...durations, 1);
}

/**
 * Get the full SLA config for a jurisdiction, falling back to default.
 */
export function getJurisdictionSLAConfig(
  jurisdiction: string,
): JurisdictionSLAConfig {
  return (
    JURISDICTION_SLA_CONFIGS[jurisdiction as DisputeJurisdiction] ??
    JURISDICTION_SLA_CONFIGS.default
  );
}

/**
 * Check if a state is terminal (no SLA tracking needed).
 */
export function isTerminalState(state: string): boolean {
  return state === 'resolved' || state === 'closed';
}

/**
 * Check if auto-escalation is enabled for a jurisdiction.
 */
export function isAutoEscalateEnabled(jurisdiction: string): boolean {
  const config = getJurisdictionSLAConfig(jurisdiction);
  return config.autoEscalate;
}
