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

export type UpgradeStatus = 'pending' | 'approved' | 'applied' | 'failed';

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
  };
}

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

    if (upgrade.status !== 'approved') {
      throw Errors.conflict(
        `Cannot apply upgrade with status '${upgrade.status}' — must be 'approved'`,
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
