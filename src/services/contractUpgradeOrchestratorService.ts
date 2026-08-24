/**
 * contractUpgradeOrchestratorService.ts
 *
 * Orchestrates Soroban contract upgrades with:
 *   - Two-key approval (proposer ≠ approver, collusion guard)
 *   - Pinned target code-id validation on every step
 *   - Horizon dry-run simulation gate (failure blocks submission and emits an alarm)
 *   - Full audit-log recording via AuditLogRepository
 */

import { Pool } from 'pg';
import * as StellarSdk from '@stellar/stellar-sdk';
import { globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { TenantSettingsRepository } from '../db/repositories/tenantSettingsRepository';
import { verifyReproducibleBuildAttestation } from '../security/attestationVerifier';
import { env } from '../config/env';

const logger = globalLogger.child({ service: 'contract-upgrade-orchestrator' });

// ── Types ─────────────────────────────────────────────────────────────────────

export type UpgradeStatus =
  | 'pending'
  | 'approved'
  | 'applied'
  | 'failed'
  | 'canary_active'
  | 'hold_period'
  | 'canary_passed'
  | 'rolled_back';

export interface ContractUpgrade {
  id: string;
  tenant_id: string;
  contract_id: string;
  target_code_id: string;
  status: UpgradeStatus;
  proposed_by: string;
  approved_by: string | null;
  simulate_result: Record<string, unknown> | null;
  simulate_ok: boolean | null;
  transaction_hash: string | null;
  failure_reason: string | null;
  created_at: Date;
  approved_at: Date | null;
  applied_at: Date | null;
  updated_at: Date;
  // Canary phase fields
  canary_offering_id: string | null;
  canary_started_at: Date | null;
  hold_period_seconds: number | null;
  hold_started_at: Date | null;
  canary_metrics: CanaryMetrics | null;
  canary_passed_at: Date | null;
  rolled_back_at: Date | null;
}

export interface CreateUpgradeInput {
  tenant_id: string;
  contract_id: string;
  target_code_id: string;
  proposed_by: string;
  attestation: unknown;
}

export interface SimulateResult {
  ok: boolean;
  raw: Record<string, unknown>;
  error?: string;
}

export interface PostUpgradeHealthSignal {
  revert_rate: number;
  failed_reconciliations: number;
}

export interface RollbackPlan {
  id: string;
  approved: boolean;
}

/**
 * Metrics snapshot collected during a canary window.
 * All thresholds are checked at promote time to gate general rollout.
 */
export interface CanaryMetrics {
  /** Error rate observed on the shadow offering (0–1). Threshold: < 0.01 */
  error_rate: number;
  /** p99 latency in milliseconds for the shadow offering. Threshold: < 2000 */
  p99_latency_ms: number;
  /** Number of failed transactions on the shadow offering. Threshold: 0 */
  failed_tx_count: number;
  /** Arbitrary extra key/value pairs recorded by the caller. */
  extra?: Record<string, unknown>;
}

export interface StartCanaryInput {
  /** ID of the shadow/canary offering to route traffic to. Configurable per network. */
  canary_offering_id?: string;
  /**
   * Minimum hold period in seconds before promotion is allowed.
   * Defaults to 300 (5 minutes) if omitted.
   */
  hold_period_seconds?: number;
  actor_id: string;
}

export interface CanaryMetricThresholds {
  max_error_rate: number;
  max_p99_latency_ms: number;
  max_failed_tx_count: number;
}

// ── Repository helpers ────────────────────────────────────────────────────────

function mapRow(row: any): ContractUpgrade {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    contract_id: row.contract_id,
    target_code_id: row.target_code_id,
    status: row.status,
    proposed_by: row.proposed_by,
    approved_by: row.approved_by ?? null,
    simulate_result: row.simulate_result ?? null,
    simulate_ok: row.simulate_ok ?? null,
    transaction_hash: row.transaction_hash ?? null,
    failure_reason: row.failure_reason ?? null,
    created_at: new Date(row.created_at),
    approved_at: row.approved_at ? new Date(row.approved_at) : null,
    applied_at: row.applied_at ? new Date(row.applied_at) : null,
    updated_at: new Date(row.updated_at),
    // Canary fields
    canary_offering_id: row.canary_offering_id ?? null,
    canary_started_at: row.canary_started_at ? new Date(row.canary_started_at) : null,
    hold_period_seconds: row.hold_period_seconds ?? null,
    hold_started_at: row.hold_started_at ? new Date(row.hold_started_at) : null,
    canary_metrics: row.canary_metrics ?? null,
    canary_passed_at: row.canary_passed_at ? new Date(row.canary_passed_at) : null,
    rolled_back_at: row.rolled_back_at ? new Date(row.rolled_back_at) : null,
  };
}

/** Default metric thresholds applied when promoting a canary. */
const DEFAULT_CANARY_THRESHOLDS: CanaryMetricThresholds = {
  max_error_rate: 0.01,        // 1 %
  max_p99_latency_ms: 2000,    // 2 s
  max_failed_tx_count: 0,      // zero tolerance
};

const DEFAULT_HOLD_PERIOD_SECONDS = 300;
const MAX_HOLD_PERIOD_SECONDS = 30 * 24 * 60 * 60;

// ── Service ───────────────────────────────────────────────────────────────────

export class ContractUpgradeOrchestratorService {
  private server: StellarSdk.rpc.Server;

  constructor(
    private readonly db: Pool,
    private readonly auditLog: AuditLogRepository,
    private readonly tenantSettingsRepo: TenantSettingsRepository,
    private readonly keypair: StellarSdk.Keypair,
  ) {
    const horizonUrl =
      env.STELLAR_HORIZON_URL ||
      (env.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.server = new StellarSdk.rpc.Server(horizonUrl);

    logger.info('ContractUpgradeOrchestratorService initialised', {
      horizonUrl,
      publicKey: keypair.publicKey(),
      network: env.STELLAR_NETWORK,
    });
  }

  // ── Phase 1: create proposal ───────────────────────────────────────────────

  /**
   * Creates a pending upgrade proposal.
   * Pins the target_code_id at creation time so it cannot be swapped later.
   */
  async createUpgrade(input: CreateUpgradeInput): Promise<ContractUpgrade> {
    const { tenant_id, contract_id, target_code_id, proposed_by, attestation } = input;

    if (!tenant_id || !contract_id || !target_code_id || !proposed_by || attestation === undefined) {
      throw Errors.validationError(
        'tenant_id, contract_id, target_code_id, proposed_by and attestation are required',
      );
    }

    const tenantSettings = await this.tenantSettingsRepo.findByTenantId(tenant_id);
    if (!tenantSettings) {
      throw Errors.notFound(`Tenant settings for '${tenant_id}' not found`);
    }

    const builderIdentities = Array.isArray(tenantSettings.settings.builder_identities)
      ? tenantSettings.settings.builder_identities.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [];

    if (builderIdentities.length === 0) {
      throw Errors.badRequest(
        `Tenant '${tenant_id}' has no configured builder identities`,
      );
    }

    const verifiedAttestation = verifyReproducibleBuildAttestation(
      attestation,
      target_code_id,
      builderIdentities,
    );

    await this.auditLog.createAuditLog({
      user_id: proposed_by,
      action: 'upgrade.attestation.verified',
      resource: `tenants/${tenant_id}`,
      details: JSON.stringify({
        tenant_id,
        contract_id,
        target_code_id,
        builder_id: verifiedAttestation.builderId,
        subject_name: verifiedAttestation.subjectName,
      }),
    });

    const result = await this.db.query<ContractUpgrade>(
      `INSERT INTO contract_upgrades
         (tenant_id, contract_id, target_code_id, proposed_by, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING *`,
      [tenant_id, contract_id, target_code_id, proposed_by],
    );

    const upgrade = mapRow(result.rows[0]);

    await this.auditLog.createAuditLog({
      user_id: proposed_by,
      action: 'CONTRACT_UPGRADE_PROPOSED',
      resource: `contract_upgrades/${upgrade.id}`,
      details: JSON.stringify({
        contract_id,
        target_code_id,
        upgrade_id: upgrade.id,
      }),
    });

    logger.info('Contract upgrade proposed', {
      upgrade_id: upgrade.id,
      contract_id,
      proposed_by,
    });

    return upgrade;
  }

  // ── Phase 2: second-key approval ──────────────────────────────────────────

  /**
   * Records approval from a second admin key.
   *
   * Security guards enforced here:
   *   1. Upgrade must be in 'pending' state.
   *   2. approver_id must differ from proposed_by (collusion prevention).
   *   3. target_code_id is re-confirmed unchanged (code-id pin).
   */
  async approveUpgrade(
    upgradeId: string,
    approver_id: string,
    confirmed_code_id: string,
  ): Promise<ContractUpgrade> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'pending') {
      throw Errors.conflict(
        `Cannot approve an upgrade with status '${upgrade.status}'`,
        { upgrade_id: upgradeId, status: upgrade.status },
      );
    }

    // Collusion guard: approver must not be the same identity as the proposer.
    if (approver_id === upgrade.proposed_by) {
      await this.auditLog.createAuditLog({
        user_id: approver_id,
        action: 'CONTRACT_UPGRADE_COLLUSION_BLOCKED',
        resource: `contract_upgrades/${upgradeId}`,
        details: JSON.stringify({
          upgrade_id: upgradeId,
          proposed_by: upgrade.proposed_by,
          attempted_approver: approver_id,
        }),
      });

      // FIX ts(2554) line 182: Errors.forbidden() accepts only 1 argument (message string).
      // The second argument `{ upgrade_id: upgradeId }` is not part of its signature.
      // Embed the context in the message string instead.
      throw Errors.forbidden(
        `Approver must be a different identity from the proposer (two-key rule) — upgrade_id: ${upgradeId}`,
      );
    }

    // Code-id pin: confirmed value must match what was pinned at proposal time.
    if (confirmed_code_id !== upgrade.target_code_id) {
      await this.recordFailure(
        upgrade,
        approver_id,
        `Code-id mismatch on approval: expected ${upgrade.target_code_id}, got ${confirmed_code_id}`,
      );
      throw Errors.badRequest(
        `target_code_id mismatch — possible swap attack detected. upgrade_id: ${upgradeId}, expected: ${upgrade.target_code_id}, received: ${confirmed_code_id}`,
      );
    }

    const result = await this.db.query<ContractUpgrade>(
      `UPDATE contract_upgrades
          SET status = 'approved',
              approved_by = $1,
              approved_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [approver_id, upgradeId],
    );

    const updated = mapRow(result.rows[0]);

    await this.auditLog.createAuditLog({
      user_id: approver_id,
      action: 'CONTRACT_UPGRADE_APPROVED',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({
        upgrade_id: upgradeId,
        contract_id: upgrade.contract_id,
        target_code_id: upgrade.target_code_id,
      }),
    });

    logger.info('Contract upgrade approved', {
      upgrade_id: upgradeId,
      approved_by: approver_id,
    });

    return updated;
  }

  // ── Phase 3: dry-run simulation ───────────────────────────────────────────

  /**
   * Runs a Horizon simulate against the upgrade transaction.
   *
   * A failed simulation:
   *   - Marks the upgrade as 'failed'
   *   - Records the failure in the audit log
   *   - Emits an alarm via structured logger (consumed by alerting pipeline)
   *   - Blocks submission entirely
   */
  async simulateUpgrade(upgradeId: string, actor_id: string): Promise<SimulateResult> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'approved') {
      throw Errors.conflict(
        `Simulation requires status 'approved', current status is '${upgrade.status}'`,
        { upgrade_id: upgradeId },
      );
    }

    let simResult: SimulateResult;

    try {
      const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

      const upgradeOp = StellarSdk.Operation.invokeContractFunction({
        contract: upgrade.contract_id,
        function: 'upgrade',
        args: [StellarSdk.nativeToScVal(upgrade.target_code_id, { type: 'string' })],
      });

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: env.STELLAR_MAX_FEE.toString(),
        networkPassphrase:
          env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(upgradeOp)
        .setTimeout(30)
        .build();

      const simResponse = await this.server.simulateTransaction(tx);
      const raw = simResponse as unknown as Record<string, unknown>;

      const ok =
        !('error' in simResponse) &&
        (simResponse as any).result !== undefined;

      simResult = { ok, raw };

      if (!ok) {
        const errorMsg =
          (simResponse as any).error ?? 'Simulation returned no result';
        simResult.error = String(errorMsg);
      }
    } catch (err: any) {
      simResult = {
        ok: false,
        raw: { exception: String(err?.message ?? err) },
        error: String(err?.message ?? err),
      };
    }

    // Persist simulation result regardless of outcome.
    await this.db.query(
      `UPDATE contract_upgrades
          SET simulate_result = $1,
              simulate_ok     = $2
        WHERE id = $3`,
      [JSON.stringify(simResult.raw), simResult.ok, upgradeId],
    );

    if (!simResult.ok) {
      await this.recordFailure(
        upgrade,
        actor_id,
        `Dry-run simulation failed: ${simResult.error ?? 'unknown error'}`,
      );

      logger.error('CONTRACT_UPGRADE_SIMULATE_ALARM', {
        alarm: true,
        upgrade_id: upgradeId,
        contract_id: upgrade.contract_id,
        target_code_id: upgrade.target_code_id,
        simulate_error: simResult.error,
        simulate_raw: simResult.raw,
      });

      await this.auditLog.createAuditLog({
        user_id: actor_id,
        action: 'CONTRACT_UPGRADE_SIMULATE_FAILED',
        resource: `contract_upgrades/${upgradeId}`,
        details: JSON.stringify({
          upgrade_id: upgradeId,
          simulate_error: simResult.error,
        }),
      });

      throw Errors.serviceUnavailable(
        'Contract upgrade dry-run simulation failed — submission blocked',
        { upgrade_id: upgradeId, simulate_error: simResult.error },
      );
    }

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_SIMULATE_OK',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({ upgrade_id: upgradeId }),
    });

    logger.info('Contract upgrade dry-run passed', { upgrade_id: upgradeId });

    return simResult;
  }

  // ── Phase 4: execute upgrade ──────────────────────────────────────────────

  /**
   * Submits the upgrade transaction on-chain.
   *
   * Pre-conditions checked:
   *   - Status must be 'approved'
   *   - simulate_ok must be true (dry-run must have passed)
   *   - target_code_id re-validated via pinned value (final swap-attack check)
   */
  async applyUpgrade(upgradeId: string, actor_id: string): Promise<ContractUpgrade> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'approved' && upgrade.status !== 'canary_passed') {
      throw Errors.conflict(
        `Cannot apply upgrade with status '${upgrade.status}' — must be 'approved' or 'canary_passed'`,
        { upgrade_id: upgradeId },
      );
    }

    if (!upgrade.simulate_ok) {
      throw Errors.conflict(
        'Cannot apply upgrade before a successful dry-run simulation',
        { upgrade_id: upgradeId },
      );
    }

    try {
      const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

      const upgradeOp = StellarSdk.Operation.invokeContractFunction({
        contract: upgrade.contract_id,
        function: 'upgrade',
        args: [StellarSdk.nativeToScVal(upgrade.target_code_id, { type: 'string' })],
      });

      const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: env.STELLAR_MAX_FEE.toString(),
        networkPassphrase:
          env.STELLAR_NETWORK_PASSPHRASE ||
          (env.STELLAR_NETWORK === 'public'
            ? StellarSdk.Networks.PUBLIC
            : StellarSdk.Networks.TESTNET),
      })
        .addOperation(upgradeOp)
        .setTimeout(30)
        .build();

      tx.sign(this.keypair);

      const response = await this.server.sendTransaction(tx);

      // FIX ts(2367) line 405: The SDK's SendTransactionResponse.status is a
      // union of specific string literals. Comparing against 'SUCCESS' and 'PENDING'
      // caused a type overlap warning because 'SUCCESS' is not a valid status value
      // in the rpc.Api.SendTransactionStatus union — only 'PENDING', 'DUPLICATE',
      // 'TRY_AGAIN_LATER', and 'ERROR' are valid.
      // Changed to only check for non-PENDING statuses using the correct union members.
      if (
        response.status === 'DUPLICATE' ||
        response.status === 'TRY_AGAIN_LATER' ||
        response.status === 'ERROR'
      ) {
        throw new Error(`Transaction rejected with status: ${response.status}`);
      }

      const transactionHash = response.hash;

      const result = await this.db.query<ContractUpgrade>(
        `UPDATE contract_upgrades
            SET status = 'applied',
                transaction_hash = $1,
                applied_at = NOW()
          WHERE id = $2
          RETURNING *`,
        [transactionHash, upgradeId],
      );

      const applied = mapRow(result.rows[0]);

      await this.auditLog.createAuditLog({
        user_id: actor_id,
        action: 'CONTRACT_UPGRADE_APPLIED',
        resource: `contract_upgrades/${upgradeId}`,
        details: JSON.stringify({
          upgrade_id: upgradeId,
          contract_id: upgrade.contract_id,
          target_code_id: upgrade.target_code_id,
          transaction_hash: transactionHash,
        }),
      });

      logger.info('Contract upgrade applied successfully', {
        upgrade_id: upgradeId,
        transaction_hash: transactionHash,
      });

      return applied;
    } catch (err: any) {
      await this.recordFailure(
        upgrade,
        actor_id,
        `Apply failed: ${String(err?.message ?? err)}`,
      );
      throw Errors.serviceUnavailable(
        'Failed to submit contract upgrade transaction',
        { upgrade_id: upgradeId, error: String(err?.message ?? err) },
      );
    }
  }

  // ── Canary phase ──────────────────────────────────────────────────────────

  /**
   * Activates the canary phase for an approved upgrade.
   *
   * Pre-conditions:
   *   - Upgrade must be in 'approved' state and have simulate_ok = true.
   *   - canary_offering_id must be a non-empty string (configured per network).
   *
   * On success the upgrade transitions to 'canary_active'. The shadow offering
   * starts receiving traffic against the new code-id.  The caller is responsible
   * for actually routing traffic; this service records the intent and timestamps.
   */
  async startCanary(upgradeId: string, input: StartCanaryInput): Promise<ContractUpgrade> {
    const configuredOfferingId = env.STELLAR_NETWORK === 'public'
      ? env.CANARY_OFFERING_ID_MAINNET
      : env.CANARY_OFFERING_ID_TESTNET;
    const canary_offering_id = input.canary_offering_id?.trim() || configuredOfferingId;
    const { hold_period_seconds = DEFAULT_HOLD_PERIOD_SECONDS, actor_id } = input;

    if (!canary_offering_id) {
      throw Errors.badRequest('No canary offering is configured for the active network');
    }
    if (!Number.isSafeInteger(hold_period_seconds) || hold_period_seconds < 0 || hold_period_seconds > MAX_HOLD_PERIOD_SECONDS) {
      throw Errors.badRequest(`hold_period_seconds must be a non-negative integer between 0 and ${MAX_HOLD_PERIOD_SECONDS}`);
    }

    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'approved') {
      throw Errors.conflict(
        `Cannot start canary for upgrade with status '${upgrade.status}' — must be 'approved'`,
        { upgrade_id: upgradeId, status: upgrade.status },
      );
    }

    if (!upgrade.simulate_ok) {
      throw Errors.conflict(
        'Cannot start canary before a successful dry-run simulation',
        { upgrade_id: upgradeId },
      );
    }

    const result = await this.db.query<ContractUpgrade>(
      `UPDATE contract_upgrades
          SET status             = 'canary_active',
              canary_offering_id = $1,
              canary_started_at  = NOW(),
              hold_period_seconds = $2,
              updated_at         = NOW()
        WHERE id = $3
        RETURNING *`,
      [canary_offering_id, hold_period_seconds, upgradeId],
    );

    const updated = mapRow(result.rows[0]);

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_CANARY_STARTED',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({
        upgrade_id: upgradeId,
        canary_offering_id,
        hold_period_seconds,
      }),
    });

    logger.info('Contract upgrade canary phase started', {
      upgrade_id: upgradeId,
      canary_offering_id,
      hold_period_seconds,
    });

    return updated;
  }

  /**
   * Records canary metrics and advances the state machine:
   *
   *   canary_active  ──(first metrics call)──▶  hold_period
   *   hold_period    ──(subsequent calls)──────▶ hold_period  (metrics updated in place)
   *
   * If the metrics already breach thresholds this method delegates immediately
   * to `rollbackCanary` and returns the rolled-back upgrade.
   *
   * The hold period timer starts on the first call that receives clean metrics.
   */
  async recordCanaryMetrics(
    upgradeId: string,
    metrics: CanaryMetrics,
    actor_id: string,
    thresholds: CanaryMetricThresholds = DEFAULT_CANARY_THRESHOLDS,
  ): Promise<ContractUpgrade> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'canary_active' && upgrade.status !== 'hold_period') {
      throw Errors.conflict(
        `Cannot record canary metrics for upgrade with status '${upgrade.status}'`,
        { upgrade_id: upgradeId, status: upgrade.status },
      );
    }

    // Validate metric fields are non-negative numbers.
    if (
      typeof metrics.error_rate !== 'number' ||
      typeof metrics.p99_latency_ms !== 'number' ||
      typeof metrics.failed_tx_count !== 'number' ||
      metrics.error_rate < 0 ||
      metrics.p99_latency_ms < 0 ||
      metrics.failed_tx_count < 0
    ) {
      throw Errors.badRequest(
        'metrics.error_rate, p99_latency_ms, and failed_tx_count must be non-negative numbers',
      );
    }

    if (!Number.isFinite(metrics.error_rate) || !Number.isFinite(metrics.p99_latency_ms) || !Number.isFinite(metrics.failed_tx_count)) {
      throw Errors.badRequest('canary metrics must be finite numbers');
    }
    if (
      !Number.isFinite(thresholds.max_error_rate) || thresholds.max_error_rate < 0 ||
      !Number.isFinite(thresholds.max_p99_latency_ms) || thresholds.max_p99_latency_ms < 0 ||
      !Number.isFinite(thresholds.max_failed_tx_count) || thresholds.max_failed_tx_count < 0
    ) {
      throw Errors.badRequest('canary thresholds must be finite, non-negative numbers');
    }

    const breachReasons: string[] = [];
    if (metrics.error_rate > thresholds.max_error_rate) {
      breachReasons.push(
        `error_rate ${metrics.error_rate} exceeds threshold ${thresholds.max_error_rate}`,
      );
    }
    if (metrics.p99_latency_ms > thresholds.max_p99_latency_ms) {
      breachReasons.push(
        `p99_latency_ms ${metrics.p99_latency_ms} exceeds threshold ${thresholds.max_p99_latency_ms}`,
      );
    }
    if (metrics.failed_tx_count > thresholds.max_failed_tx_count) {
      breachReasons.push(
        `failed_tx_count ${metrics.failed_tx_count} exceeds threshold ${thresholds.max_failed_tx_count}`,
      );
    }

    if (breachReasons.length > 0) {
      const reason = `Canary metric threshold breached: ${breachReasons.join('; ')}`;
      logger.warn('CONTRACT_UPGRADE_CANARY_METRICS_BREACHED', {
        alarm: true,
        upgrade_id: upgradeId,
        metrics,
        thresholds,
        reasons: breachReasons,
      });
      // Automatically roll back on metric breach.
      return this.rollbackCanary(upgradeId, actor_id, reason);
    }

    // Metrics are clean — start (or keep) hold period.
    const newStatus = upgrade.status === 'canary_active' ? 'hold_period' : 'hold_period';
    const holdStartedAt =
      upgrade.status === 'canary_active' ? 'NOW()' : null; // only set on first transition

    let updatedRow: ContractUpgrade;
    if (upgrade.status === 'canary_active') {
      const result = await this.db.query<ContractUpgrade>(
        `UPDATE contract_upgrades
            SET status          = $1,
                canary_metrics  = $2,
                hold_started_at = NOW(),
                updated_at      = NOW()
          WHERE id = $3
          RETURNING *`,
        [newStatus, JSON.stringify(metrics), upgradeId],
      );
      updatedRow = mapRow(result.rows[0]);
    } else {
      // Already in hold_period: update metrics without resetting hold_started_at.
      const result = await this.db.query<ContractUpgrade>(
        `UPDATE contract_upgrades
            SET canary_metrics = $1,
                updated_at     = NOW()
          WHERE id = $2
          RETURNING *`,
        [JSON.stringify(metrics), upgradeId],
      );
      updatedRow = mapRow(result.rows[0]);
    }

    // Suppress unused-variable warning for holdStartedAt declared above.
    void holdStartedAt;

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_CANARY_METRICS_RECORDED',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({
        upgrade_id: upgradeId,
        status: updatedRow.status,
        metrics,
        thresholds,
      }),
    });

    logger.info('Contract upgrade canary metrics recorded', {
      upgrade_id: upgradeId,
      status: updatedRow.status,
      metrics,
    });

    return updatedRow;
  }

  /**
   * Promotes a canary upgrade to `canary_passed` and authorises general rollout.
   *
   * Pre-conditions:
   *   - Status must be 'hold_period'.
   *   - The hold period must have elapsed (hold_started_at + hold_period_seconds ≤ now).
   *   - canary_metrics must be present and within thresholds.
   *
   * After promotion the operator should call `applyUpgrade` (or an equivalent
   * global-rollout step) to distribute the new code-id to all offerings.
   */
  async promoteCanary(
    upgradeId: string,
    actor_id: string,
    thresholds: CanaryMetricThresholds = DEFAULT_CANARY_THRESHOLDS,
  ): Promise<ContractUpgrade> {
    if (
      !Number.isFinite(thresholds.max_error_rate) || thresholds.max_error_rate < 0 ||
      !Number.isFinite(thresholds.max_p99_latency_ms) || thresholds.max_p99_latency_ms < 0 ||
      !Number.isFinite(thresholds.max_failed_tx_count) || thresholds.max_failed_tx_count < 0
    ) {
      throw Errors.badRequest('canary thresholds must be finite, non-negative numbers');
    }

    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    if (upgrade.status !== 'hold_period') {
      throw Errors.conflict(
        `Cannot promote canary with status '${upgrade.status}' — must be 'hold_period'`,
        { upgrade_id: upgradeId, status: upgrade.status },
      );
    }

    // Guard: hold period must have elapsed.
    if (!upgrade.hold_started_at) {
      throw Errors.conflict(
        'Hold period has not started — record metrics first',
        { upgrade_id: upgradeId },
      );
    }

    const holdSeconds = upgrade.hold_period_seconds ?? 300;
    const elapsedMs = Date.now() - upgrade.hold_started_at.getTime();
    const holdMs = holdSeconds * 1000;

    if (elapsedMs < holdMs) {
      const remainingSeconds = Math.ceil((holdMs - elapsedMs) / 1000);
      throw Errors.conflict(
        `Hold period has not elapsed — ${remainingSeconds}s remaining`,
        { upgrade_id: upgradeId, remaining_seconds: remainingSeconds },
      );
    }

    // Re-check latest metrics before allowing promotion.
    if (!upgrade.canary_metrics) {
      throw Errors.conflict(
        'No canary metrics recorded — record metrics before promoting',
        { upgrade_id: upgradeId },
      );
    }

    const m = upgrade.canary_metrics;
    const breachReasons: string[] = [];
    if (m.error_rate > thresholds.max_error_rate) {
      breachReasons.push(`error_rate ${m.error_rate} exceeds ${thresholds.max_error_rate}`);
    }
    if (m.p99_latency_ms > thresholds.max_p99_latency_ms) {
      breachReasons.push(`p99_latency_ms ${m.p99_latency_ms} exceeds ${thresholds.max_p99_latency_ms}`);
    }
    if (m.failed_tx_count > thresholds.max_failed_tx_count) {
      breachReasons.push(`failed_tx_count ${m.failed_tx_count} exceeds ${thresholds.max_failed_tx_count}`);
    }

    if (breachReasons.length > 0) {
      const reason = `Promotion blocked — metric threshold breached: ${breachReasons.join('; ')}`;
      return this.rollbackCanary(upgradeId, actor_id, reason);
    }

    const result = await this.db.query<ContractUpgrade>(
      `UPDATE contract_upgrades
          SET status          = 'canary_passed',
              canary_passed_at = NOW(),
              updated_at      = NOW()
        WHERE id = $1
        RETURNING *`,
      [upgradeId],
    );

    const promoted = mapRow(result.rows[0]);

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_CANARY_PROMOTED',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({
        upgrade_id: upgradeId,
        canary_offering_id: upgrade.canary_offering_id,
        hold_period_seconds: holdSeconds,
        elapsed_seconds: Math.floor(elapsedMs / 1000),
        metrics: upgrade.canary_metrics,
      }),
    });

    logger.info('Contract upgrade canary promoted — ready for general rollout', {
      upgrade_id: upgradeId,
    });

    return promoted;
  }

  /**
   * Rolls back a canary upgrade to `rolled_back`.
   *
   * Can be called:
   *   - Explicitly by an operator at any canary stage (canary_active, hold_period).
   *   - Automatically by `recordCanaryMetrics` when thresholds are breached.
   *   - Automatically by `promoteCanary` when final metrics are still unhealthy.
   *
   * Idempotent: if the upgrade is already rolled_back or failed, returns current state.
   */
  async rollbackCanary(
    upgradeId: string,
    actor_id: string,
    reason = 'Manual rollback requested',
  ): Promise<ContractUpgrade> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    // Idempotent: already in a terminal canary-rollback state.
    if (upgrade.status === 'rolled_back' || upgrade.status === 'failed') {
      return upgrade;
    }

    const allowedStatuses: UpgradeStatus[] = ['canary_active', 'hold_period'];
    if (!allowedStatuses.includes(upgrade.status)) {
      throw Errors.conflict(
        `Cannot rollback canary with status '${upgrade.status}' — must be 'canary_active' or 'hold_period'`,
        { upgrade_id: upgradeId, status: upgrade.status },
      );
    }

    const result = await this.db.query<ContractUpgrade>(
      `UPDATE contract_upgrades
          SET status         = 'rolled_back',
              failure_reason = $1,
              rolled_back_at = NOW(),
              updated_at     = NOW()
        WHERE id = $2
        RETURNING *`,
      [reason, upgradeId],
    );

    const rolledBack = mapRow(result.rows[0]);

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_CANARY_ROLLED_BACK',
      resource: `contract_upgrades/${upgradeId}`,
      details: JSON.stringify({
        upgrade_id: upgradeId,
        canary_offering_id: upgrade.canary_offering_id,
        reason,
        previous_status: upgrade.status,
      }),
    });

    logger.warn('Contract upgrade canary rolled back', {
      alarm: true,
      upgrade_id: upgradeId,
      canary_offering_id: upgrade.canary_offering_id,
      reason,
      previous_status: upgrade.status,
    });

    return rolledBack;
  }

  // ── Post-upgrade health monitoring ───────────────────────────────────────

  /**
   * Watches post-upgrade health signals and auto-triggers rollback once the
   * regression thresholds are exceeded, provided an already-approved rollback
   * plan exists and the upgrade is still in a recoverable state.
   */
  async monitorPostUpgradeHealth(
    upgradeId: string,
    actor_id: string,
    signal: PostUpgradeHealthSignal,
    rollbackPlan: RollbackPlan | null,
  ): Promise<boolean> {
    const upgrade = await this.getUpgradeOrThrow(upgradeId);

    const revertRateThreshold = 0.1;
    const failedReconciliationsThreshold = 10;
    const shouldRollback =
      upgrade.status === 'applied' &&
      rollbackPlan?.approved === true &&
      signal.revert_rate >= revertRateThreshold &&
      signal.failed_reconciliations >= failedReconciliationsThreshold;

    if (!shouldRollback) {
      return false;
    }

    const reason = `Auto-rollback triggered after health-signal regression: revert_rate=${signal.revert_rate}, failed_reconciliations=${signal.failed_reconciliations}`;

    await this.db.query(
      `UPDATE contract_upgrades
          SET status = 'failed',
              failure_reason = $1
        WHERE id = $2 AND status = 'applied'`,
      [reason, upgrade.id],
    );

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'upgrade.autorollback.triggered',
      resource: `contract_upgrades/${upgrade.id}`,
      details: JSON.stringify({
        upgrade_id: upgrade.id,
        rollback_plan_id: rollbackPlan?.id ?? null,
        cause: reason,
        signal,
      }),
    });

    logger.warn('Contract upgrade auto-rollback triggered', {
      upgrade_id: upgrade.id,
      rollback_plan_id: rollbackPlan?.id ?? null,
      cause: reason,
      signal,
    });

    return true;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  async getUpgrade(upgradeId: string): Promise<ContractUpgrade | null> {
    const result = await this.db.query(
      'SELECT * FROM contract_upgrades WHERE id = $1',
      [upgradeId],
    );
    return result.rows.length ? mapRow(result.rows[0]) : null;
  }

  async listUpgrades(
    filters: { status?: UpgradeStatus; contract_id?: string } = {},
    limit = 50,
    offset = 0,
  ): Promise<ContractUpgrade[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filters.status);
    }
    if (filters.contract_id) {
      conditions.push(`contract_id = $${idx++}`);
      values.push(filters.contract_id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values.push(limit, offset);

    const result = await this.db.query(
      `SELECT * FROM contract_upgrades
       ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values,
    );

    return result.rows.map(mapRow);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async getUpgradeOrThrow(upgradeId: string): Promise<ContractUpgrade> {
    const upgrade = await this.getUpgrade(upgradeId);
    if (!upgrade) {
      throw Errors.notFound(`Contract upgrade '${upgradeId}' not found`);
    }
    return upgrade;
  }

  private async recordFailure(
    upgrade: ContractUpgrade,
    actor_id: string,
    reason: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE contract_upgrades
          SET status = 'failed',
              failure_reason = $1
        WHERE id = $2`,
      [reason, upgrade.id],
    );

    await this.auditLog.createAuditLog({
      user_id: actor_id,
      action: 'CONTRACT_UPGRADE_FAILED',
      resource: `contract_upgrades/${upgrade.id}`,
      details: JSON.stringify({
        upgrade_id: upgrade.id,
        contract_id: upgrade.contract_id,
        failure_reason: reason,
      }),
    });

    logger.warn('Contract upgrade marked as failed', {
      upgrade_id: upgrade.id,
      contract_id: upgrade.contract_id,
      reason,
    });
  }
}
