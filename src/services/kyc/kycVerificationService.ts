/**
 * KYC/AML Verification Service
 *
 * Owns the side effects of a verified provider callback:
 *
 *  1. **Validation** – rejects malformed or empty payloads (fail-closed).
 *  2. **Replay protection** – a {@link KycReplayGuard} claims each provider
 *     transaction id exactly once; replays are rejected with a safe outcome.
 *  3. **Replayable audit trail** – every accepted callback is persisted to the
 *     audit log keyed by the provider transaction id (`provider_tx_id`), so
 *     the complete verification history can be replayed/audited offline.
 *  4. **Status mutation** – the investor's `kyc_status` is updated to the
 *     provider-reported status; `approved` unlocks investing, anything else
 *     keeps the gate closed.
 *
 * Fail-closed decisions:
 * - Unknown/malformed transaction id or status → rejected, nothing mutated.
 * - Unknown investor id → the callback is still audited (with `user_not_found`)
 *   but status is not mutated, so no account is silently created or upgraded.
 */

import { globalLogger } from '../../lib/logger';
import { globalMetrics } from '../../lib/metrics';
import { KycStatus, KycCheckResult } from './KycProvider';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import {
  DEFAULT_KYC_STATUS,
  UserRepository,
  parseKycStatus,
} from '../../db/repositories/userRepository';

export const KYC_VERIFICATION_ACTION = 'kyc.verification.received';

const VALID_SAFE_STATUSES: readonly KycStatus[] = [
  'pending',
  'in_review',
  'approved',
  'rejected',
];

/**
 * In-memory replay guard keyed by provider transaction id.
 *
 * Mirrors the process-lifetime semantics of `EventOrderingTracker` and the KYC
 * circuit breaker state: sufficient for a single-instance deployment. A
 * distributed store (e.g. Redis) must be substituted for multi-instance
 * deployments, exactly like the rest of the in-process state in this service.
 */
export interface KycReplayGuard {
  /** Whether the event id has already been permanently processed. */
  isDuplicate(providerTxId: string): boolean;
  /** Atomically claim an event id. Returns false when already claimed/processed. */
  claim(providerTxId: string): boolean;
  /** Release a claim (failed processing so a retry may try again). */
  release(providerTxId: string): void;
  /** Permanently record the event id as processed. */
  commit(providerTxId: string): void;
}

export class InMemoryKycReplayGuard implements KycReplayGuard {
  private readonly processed = new Set<string>();
  private readonly claimed = new Set<string>();

  isDuplicate(providerTxId: string): boolean {
    return this.processed.has(providerTxId);
  }

  claim(providerTxId: string): boolean {
    if (this.processed.has(providerTxId)) return false;
    if (this.claimed.has(providerTxId)) return false;
    this.claimed.add(providerTxId);
    return true;
  }

  release(providerTxId: string): void {
    this.claimed.delete(providerTxId);
  }

  commit(providerTxId: string): void {
    this.claimed.delete(providerTxId);
    this.processed.add(providerTxId);
  }
}

/** Normalized, validated KYC callback payload. */
export interface KycCallbackEvent {
  providerTxId: string;
  referenceId: string;
  status: KycStatus;
  provider: string;
  investorId?: string;
  occurredAt?: string;
  verifiedByKey?: 'current' | 'next' | 'none';
  receivedAt: string;
}

export type KycCallbackOutcomeStatus =
  | 'accepted'
  | 'duplicate'
  | 'rejected'
  | 'user_not_found'
  | 'user_missing';

export interface KycCallbackOutcome {
  outcome: KycCallbackOutcomeStatus;
  providerTxId: string;
  status: KycStatus;
  investorId?: string;
}

export interface KycVerificationServiceOptions {
  /** When true, user status is mutated to the callback verdict (feature flag). */
  enabled: boolean;
  replayGuard?: KycReplayGuard;
}

/**
 * Parses and validates a provider callback payload. Returns `null` for any
 * malformed input so callers can fail closed.
 */
export function parseKycCallbackEvent(
  payload: unknown,
  verifiedByKey?: 'current' | 'next',
): KycCallbackEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const providerTxId = raw.provider_tx_id;
  const referenceId = raw.reference_id ?? raw.referenceId;
  const status = parseKycStatus(raw.status);
  const provider = raw.provider;
  const investorId = raw.investor_id ?? raw.investorId;
  const occurredAt = raw.occurred_at ?? raw.occurredAt;

  if (typeof providerTxId !== 'string' || providerTxId.trim().length === 0) return null;
  if (typeof referenceId !== 'string' || referenceId.trim().length === 0) return null;
  if (typeof provider !== 'string' || provider.trim().length === 0) return null;
  if (!(VALID_SAFE_STATUSES as readonly string[]).includes(status)) return null;
  if (investorId !== undefined && typeof investorId !== 'string') return null;
  if (occurredAt !== undefined && typeof occurredAt !== 'string') return null;

  return {
    providerTxId: providerTxId.trim(),
    referenceId: referenceId.trim(),
    status,
    provider: provider.trim(),
    investorId: typeof investorId === 'string' ? investorId : undefined,
    occurredAt: typeof occurredAt === 'string' ? occurredAt : undefined,
    verifiedByKey: verifiedByKey ?? 'current',
    receivedAt: new Date().toISOString(),
  };
}

export class KycVerificationService {
  private readonly enabled: boolean;
  private readonly replayGuard: KycReplayGuard;

  constructor(
    private readonly userRepo: UserRepository,
    private readonly auditRepo: AuditLogRepository,
    options: KycVerificationServiceOptions,
  ) {
    this.enabled = options.enabled;
    this.replayGuard = options.replayGuard ?? new InMemoryKycReplayGuard();
  }

  /**
   * Processes a signature-verified provider callback.
   *
   * Order of operations (safe under retries):
   *  - validate payload → null => `rejected` (no side effects)
   *  - claim provider tx id → already processed/claimed => `duplicate`
   *  - write audit log entry (replayable trail, keyed by provider tx id)
   *  - if investorId present, update user status; missing user => `user_not_found`
   *  - commit the claim (release on failure so a provider retry can retry)
   */
  async recordVerifiedCallback(
    payload: unknown,
    meta?: { verifiedByKey?: 'current' | 'next' },
  ): Promise<KycCallbackOutcome> {
    const event = parseKycCallbackEvent(payload, meta?.verifiedByKey);
    if (!event) {
      globalLogger.warn('KYC callback rejected: malformed or empty payload');
      return { outcome: 'rejected', providerTxId: 'unknown', status: DEFAULT_KYC_STATUS };
    }

    if (!this.replayGuard.claim(event.providerTxId)) {
      globalLogger.warn('KYC callback replay detected', {
        providerTxId: event.providerTxId,
        referenceId: event.referenceId,
      });
      globalMetrics.incrementCounter('kyc.verification.replay', { provider: event.provider });
      return {
        outcome: 'duplicate',
        providerTxId: event.providerTxId,
        status: event.status,
        investorId: event.investorId,
      };
    }

    try {
      const auditDetails: Record<string, unknown> = {
        provider_tx_id: event.providerTxId,
        reference_id: event.referenceId,
        status: event.status,
        provider: event.provider,
        investor_id: event.investorId ?? null,
        verified_by_key: event.verifiedByKey,
        occurred_at: event.occurredAt ?? null,
        received_at: event.receivedAt,
        replayable: true,
      };

      await this.writeAudit(event, auditDetails);

      if (!event.investorId) {
        // Audited but not attributable to an investor — no mutation.
        return { outcome: 'accepted', providerTxId: event.providerTxId, status: event.status };
      }

      if (!this.enabled) {
        // Feature flag off: audit only, never mutate status (backward compat).
        globalLogger.info('KYC callback accepted (flag off — status not mutated)', {
          providerTxId: event.providerTxId,
        });
        return { outcome: 'accepted', providerTxId: event.providerTxId, status: event.status };
      }

      const user = await this.userRepo.findById(event.investorId);
      if (!user) {
        globalLogger.warn('KYC callback for unknown investor', {
          investorId: event.investorId,
          providerTxId: event.providerTxId,
        });
        await this.writeAudit(event, {
          ...auditDetails,
          provider_tx_id: event.providerTxId,
          status: event.status,
          reason: 'user_not_found',
        });
        return {
          outcome: 'user_not_found',
          providerTxId: event.providerTxId,
          status: event.status,
          investorId: event.investorId,
        };
      }

      await this.userRepo.updateKycVerification(event.investorId, {
        status: event.status,
        provider: event.provider,
        referenceId: event.referenceId,
      });
      this.replayGuard.commit(event.providerTxId);

      globalMetrics.incrementCounter('kyc.verification.accepted', { provider: event.provider });
      return {
        outcome: 'accepted',
        providerTxId: event.providerTxId,
        status: event.status,
        investorId: event.investorId,
      };
    } catch (err) {
      // Release the claim so a provider retry can be processed later.
      this.replayGuard.release(event.providerTxId);
      globalLogger.error('KYC callback processing failed', {
        providerTxId: event.providerTxId,
        error: err,
      });
      throw err;
    }
  }

  private async writeAudit(
    event: KycCallbackEvent,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRepo.createAuditLog({
      user_id: event.investorId ?? null,
      action: KYC_VERIFICATION_ACTION,
      resource: `kyc/check/${event.referenceId}`,
      details: JSON.stringify(details),
      ip_address: null,
      user_agent: `kyc-provider/${event.provider}`,
    });
  }

  /**
   * Whether an investment submission may proceed for the given user record.
   * Gate is only enforced when the feature flag is enabled.
   */
  isInvestorApproved(user: { kyc_status: KycStatus } | undefined | null): boolean {
    if (!this.enabled) return true;
    return user?.kyc_status === 'approved';
  }
}