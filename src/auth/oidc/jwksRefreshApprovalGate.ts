import { randomBytes } from 'crypto';

/**
 * Two-step dual-control approval gate for JWKS force-refreshes.
 *
 * This is an in-memory (process-local) gate modeled on the existing
 * two-approval patterns in this codebase (OFAC review queue,
 * tenantSettingsService proposal/approval, ledger period-close):
 * the proposer records the first approval by proposing, and a *distinct*
 * admin must approve within a time window for the action to execute.
 *
 * Security properties:
 * - Self-approval is rejected (collusion guard): the proposer cannot be
 *   the approver.
 * - Approvals expire after `ttlMs` and must be re-proposed (mirrors the
 *   OFAC review expiry/reset semantics).
 * - Only one active approval per scope (issuer, or the global scope for
 *   "refresh all tracked issuers") to prevent duplicate in-flight work.
 * - An already-executed approval cannot be approved again.
 * - No PII is stored — only admin identifiers and the issuer scope.
 *
 * NOTE (review): this is a NEW pattern for the API layer. The repo's
 * other dual-control flows are DB-backed (persistent across restarts);
 * this gate is intentionally process-local because it only guards an
 * idempotent, low-risk cache reload. A restart discards pending
 * approvals, which is safe (the worst case is a re-proposal).
 */

export type JwksRefreshApprovalStatus = 'pending_second_approval' | 'approved';

export interface JwksRefreshApproval {
  approvalId: string;
  /** Dedupe scope: the issuer URL, or {@link ALL_ISSUERS_SCOPE} for all tracked issuers. */
  scope: string;
  /** Specific issuer to refresh, or undefined for "all tracked issuers". */
  issuer?: string;
  /** Admin identity that proposed (first approval). */
  proposer: string;
  /** Epoch ms when the proposal was created. */
  createdAt: number;
  /** Epoch ms after which the approval is void. */
  expiresAt: number;
  status: JwksRefreshApprovalStatus;
}

/** Sentinel scope value for "refresh all tracked issuers". */
export const ALL_ISSUERS_SCOPE = '*';

/** Default time window for a second admin to approve. */
export const JWKS_REFRESH_APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`Unknown JWKS refresh approval "${approvalId}"`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalExpiredError extends Error {
  constructor(approvalId: string) {
    super(`JWKS refresh approval "${approvalId}" has expired — propose a new refresh`);
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalSelfApprovalError extends Error {
  constructor() {
    super('The proposer of a JWKS refresh cannot self-approve (dual-control)');
    this.name = 'ApprovalSelfApprovalError';
  }
}

export class ApprovalAlreadyApprovedError extends Error {
  constructor(approvalId: string) {
    super(`JWKS refresh approval "${approvalId}" has already been approved and executed`);
    this.name = 'ApprovalAlreadyApprovedError';
  }
}

export class DuplicateApprovalError extends Error {
  /** The approvalId of the already-pending proposal for the same scope. */
  public readonly existingApprovalId: string;
  constructor(scope: string, existingApprovalId: string) {
    super(`A JWKS refresh for scope "${scope}" is already pending approval`);
    this.name = 'DuplicateApprovalError';
    this.existingApprovalId = existingApprovalId;
  }
}

export interface JwksRefreshApprovalGateOptions {
  /** Time window in ms for the second approval. Default 5 minutes. */
  ttlMs?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
  /** Injectable approval-id generator for deterministic tests. */
  randomId?: () => string;
}

export class JwksRefreshApprovalGate {
  private readonly approvals = new Map<string, JwksRefreshApproval>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(options: JwksRefreshApprovalGateOptions = {}) {
    this.ttlMs = options.ttlMs ?? JWKS_REFRESH_APPROVAL_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomBytes(16).toString('base64url'));
  }

  /**
   * Step 1 of dual-control. Records `actor` as proposer (first approval)
   * for the scope and returns the pending approval. Throws
   * {@link DuplicateApprovalError} when an unexpired approval already
   * exists for the same scope.
   */
  propose(actor: string, issuer?: string): JwksRefreshApproval {
    const scope = issuer ?? ALL_ISSUERS_SCOPE;
    const existing = this.findActiveByScope(scope);
    if (existing) {
      throw new DuplicateApprovalError(scope, existing.approvalId);
    }

    const now = this.now();
    const approval: JwksRefreshApproval = {
      approvalId: this.randomId(),
      scope,
      issuer,
      proposer: actor,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      status: 'pending_second_approval',
    };
    this.approvals.set(approval.approvalId, approval);
    return approval;
  }

  /**
   * Step 2 of dual-control. `actor` (must differ from the proposer)
   * approves the pending request within its time window. On success the
   * approval is marked `approved` and the caller may execute the refresh.
   *
   * @throws {ApprovalNotFoundError} unknown approvalId
   * @throws {ApprovalExpiredError} past the time window (entry removed)
   * @throws {ApprovalSelfApprovalError} actor is the proposer
   * @throws {ApprovalAlreadyApprovedError} already executed
   */
  approve(approvalId: string, actor: string): JwksRefreshApproval {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new ApprovalNotFoundError(approvalId);
    if (approval.status === 'approved') throw new ApprovalAlreadyApprovedError(approvalId);
    if (this.now() > approval.expiresAt) {
      this.approvals.delete(approvalId);
      throw new ApprovalExpiredError(approvalId);
    }
    if (approval.proposer === actor) throw new ApprovalSelfApprovalError();

    approval.status = 'approved';
    return approval;
  }

  /** Read a single approval (audit/tests). Returns undefined when unknown. */
  get(approvalId: string): JwksRefreshApproval | undefined {
    const approval = this.approvals.get(approvalId);
    if (!approval) return undefined;
    if (approval.status === 'pending_second_approval' && this.now() > approval.expiresAt) {
      return undefined; // expired entries are treated as absent
    }
    return approval;
  }

  /** Remove expired pending approvals; returns the number removed. */
  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, approval] of this.approvals.entries()) {
      if (approval.status === 'pending_second_approval' && now > approval.expiresAt) {
        this.approvals.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /** Clear all state (test/restart helper). */
  reset(): void {
    this.approvals.clear();
  }

  private findActiveByScope(scope: string): JwksRefreshApproval | undefined {
    for (const approval of this.approvals.values()) {
      if (approval.scope !== scope) continue;
      if (approval.status === 'approved') continue;
      if (this.now() > approval.expiresAt) continue;
      return approval;
    }
    return undefined;
  }
}
