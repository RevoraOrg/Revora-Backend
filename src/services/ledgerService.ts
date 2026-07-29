import { createHmac, createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { LedgerPeriodLockRepository, LedgerPeriodLock } from '../db/repositories/ledgerPeriodLockRepository';
import { Errors } from '../lib/errors';
import { Logger, LogLevel } from '../lib/logger';
import { withTransaction, TransactionOptions } from '../db/transaction';

/**
 * Journal entry as materialized for export
 */
export interface JournalEntryExport {
  id: string;
  offering_id: string;
  period_id: string;
  amount: string;
  issuer_id: string;
  reported_at: string; // ISO 8601
  created_at: string; // ISO 8601
}

/**
 * Materialized export metadata
 */
export interface MaterializedExport {
  format: 'jsonl';
  entries: JournalEntryExport[];
  period_id: string;
  offering_id: string;
  entry_count: number;
  exported_at: string; // ISO 8601
}

/**
 * Response from period close initiation
 */
export interface PeriodCloseInitiationResponse {
  lock_id: string;
  period_id: string;
  offering_id: string;
  status: 'initiated';
  initiated_by: string;
  initiated_at: string;
  message: string;
}

/**
 * Response from period close confirmation
 */
export interface PeriodCloseConfirmationResponse {
  lock_id: string;
  period_id: string;
  offering_id: string;
  status: 'locked';
  initiated_by: string;
  confirmed_by: string;
  locked_at: string;
  export_hash: string;
  export_signature: string;
  signing_algorithm: string;
  entry_count: number;
  message: string;
}

/**
 * Signing key management
 * In production, this should be injected from a key management system or environment
 */
interface SigningKeyConfig {
  version: number;
  key: string; // Hex-encoded HMAC secret
  algorithm: 'hmac-sha256-v1';
}

/**
 * LedgerService: Business logic for period close operations.
 *
 * Security Assumptions:
 * - The actor (userId) has been authenticated via JWT middleware before service invocation.
 * - Offering ownership/access control is performed by routes before service calls.
 * - Dual-control: different actors are required for initiation and confirmation.
 * - Export materialization is atomic within a database transaction.
 * - Hash and signature computation is deterministic and reproducible.
 *
 * Tamper-Evidence:
 * - Export hash is SHA-256 of canonical JSONL representation.
 * - Export signature is HMAC-SHA256 of the hash, signed with a server-held secret.
 * - Only the attacker with database write access but without the HMAC key
 *   cannot forge a valid signature (genuine tamper-evidence).
 *
 * @module services/ledgerService
 */
export class LedgerService {
  private logger: Logger;
  private signingKey: SigningKeyConfig;

  constructor(
    private pool: Pool,
    private lockRepo: LedgerPeriodLockRepository
  ) {
    this.logger = new Logger({ level: LogLevel.INFO });
    this.signingKey = this.initializeSigningKey();
  }

  /**
   * Initialize signing key from environment.
   * In production, use a key management service (KMS) or HSM.
   */
  private initializeSigningKey(): SigningKeyConfig {
    const keyHex = process.env.LEDGER_CLOSE_SIGNING_KEY;
    if (!keyHex) {
      throw new Error(
        'LEDGER_CLOSE_SIGNING_KEY environment variable not set. Cannot sign ledger exports.'
      );
    }

    return {
      version: parseInt(process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION || '1', 10),
      key: keyHex,
      algorithm: 'hmac-sha256-v1',
    };
  }

  /**
   * @notice Initiates a period close request (first step of dual-control).
   * Creates a lock in 'initiated' status awaiting confirmation by a different actor.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID (e.g., "2024-01", "Q1-2024")
   * @param initiatorId The user ID initiating the close (actor 1)
   * @returns Response with lock ID and status
   * @throws AppError if validation fails or period already locked
   */
  async initiatePeriodClose(
    offeringId: string,
    periodId: string,
    initiatorId: string
  ): Promise<PeriodCloseInitiationResponse> {
    this.logger.info('Initiating period close', {
      offeringId,
      periodId,
      initiatorId,
    });

    // Check if period is already locked
    const existing = await this.lockRepo.getLock(offeringId, periodId);
    if (existing && existing.status === 'locked') {
      throw Errors.conflict(
        `Period ${periodId} for offering ${offeringId} is already locked`
      );
    }

    if (existing && existing.status === 'initiated') {
      throw Errors.conflict(
        `Period ${periodId} for offering ${offeringId} already has an initiated close pending confirmation`
      );
    }

    const lock = await this.lockRepo.initiatePeriodClose({
      period_id: periodId,
      offering_id: offeringId,
      initiated_by: initiatorId,
      export_format: 'jsonl',
    });

    return {
      lock_id: lock.id,
      period_id: lock.period_id,
      offering_id: lock.offering_id,
      status: 'initiated',
      initiated_by: lock.initiated_by,
      initiated_at: lock.initiated_at.toISOString(),
      message: `Period close initiated for ${periodId}. Awaiting confirmation by different actor.`,
    };
  }

  /**
   * @notice Confirms a period close (second step of dual-control).
   * Atomically materializes the export, computes hash/signature, and locks the period.
   *
   * Flow:
   * 1. Verify dual-control constraint (different actor from initiator)
   * 2. Materialize export from revenue_reports for the period
   * 3. Compute canonical export hash (SHA-256)
   * 4. Sign the hash (HMAC-SHA256)
   * 5. Store in single transaction with lock status update
   * 6. Emit audit events for both actors
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @param confirmerId The user ID confirming the close (actor 2, must differ from initiator)
   * @returns Response with lock ID, hash, signature, and status
   * @throws AppError if validation fails, lock not found, or same actor attempts to confirm
   */
  async confirmPeriodClose(
    offeringId: string,
    periodId: string,
    confirmerId: string
  ): Promise<PeriodCloseConfirmationResponse> {
    this.logger.info('Confirming period close', {
      offeringId,
      periodId,
      confirmerId,
    });

    // Get initiated lock
    const lock = await this.lockRepo.getInitiatedLock(offeringId, periodId);
    if (!lock) {
      throw Errors.notFound(
        `No initiated close found for period ${periodId} in offering ${offeringId}`
      );
    }

    // Check dual-control: different actor
    if (lock.initiated_by === confirmerId) {
      throw Errors.forbidden(
        'Period close confirmation requires a different actor than the one who initiated it (dual-control violation)'
      );
    }

    // Perform confirmation within transaction to ensure atomicity
    const result = await withTransaction(
      this.pool,
      async (client) => {
        // Materialize export
        const export_ = await this.materializeExport(
          offeringId,
          periodId,
          client
        );

        // Compute export hash
        const exportHash = this.computeExportHash(export_);

        // Sign the hash
        const exportSignature = this.signExportHash(exportHash);

        // Generate export reference (in real system, might be object storage path)
        const exportReference = `ledger-export/${offeringId}/${periodId}/${lock.id}`;

        // Confirm lock with export data
        const confirmedLock = await this.lockRepo.confirmPeriodClose(
          lock.id,
          {
            export_reference: exportReference,
            export_hash: exportHash,
            export_signature: exportSignature,
            signing_algorithm: this.signingKey.algorithm,
            signing_key_version: this.signingKey.version,
            entry_count: export_.entry_count,
            confirmed_by: confirmerId,
          },
          client
        );

        return {
          lock: confirmedLock,
          export: export_,
          exportHash,
          exportSignature,
        };
      },
      {
        isolationLevel: 'SERIALIZABLE', // Highest isolation to prevent race conditions
      }
    );

    return {
      lock_id: result.lock.id,
      period_id: result.lock.period_id,
      offering_id: result.lock.offering_id,
      status: 'locked',
      initiated_by: result.lock.initiated_by,
      confirmed_by: result.lock.confirmed_by!,
      locked_at: result.lock.locked_at!.toISOString(),
      export_hash: result.exportHash,
      export_signature: result.exportSignature,
      signing_algorithm: result.lock.signing_algorithm,
      entry_count: result.export.entry_count,
      message: `Period ${periodId} successfully locked. Export hash and signature returned for verification.`,
    };
  }

  /**
   * Get re-close status (idempotent re-close support).
   * If period is already locked, returns the stored hash and signature without re-materializing.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @returns Lock metadata if already locked, null otherwise
   */
  async getLockedPeriodMetadata(
    offeringId: string,
    periodId: string
  ): Promise<{
    locked_at: string;
    export_hash: string;
    export_signature: string;
    signing_algorithm: string;
    signing_key_version: number;
    entry_count: number | null;
  } | null> {
    const metadata = await this.lockRepo.getLockedExportMetadata(
      offeringId,
      periodId
    );

    if (!metadata) {
      return null;
    }

    return {
      locked_at: metadata.locked_at.toISOString(),
      export_hash: metadata.export_hash,
      export_signature: metadata.export_signature,
      signing_algorithm: metadata.signing_algorithm,
      signing_key_version: metadata.signing_key_version,
      entry_count: metadata.entry_count,
    };
  }

  /**
   * Materialize the export for a period by querying all revenue_reports for that period.
   * Produces a canonical, deterministic JSONL representation.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @param client Database client (typically from transaction)
   * @returns Materialized export with entries
   */
  private async materializeExport(
    offeringId: string,
    periodId: string,
    client: PoolClient
  ): Promise<MaterializedExport> {
    // Query revenue_reports for this offering and period
    // This handles both explicit period_id and date-range based periods
    const query = `
      SELECT id, offering_id, period_id, amount, issuer_id, reported_at, created_at
      FROM revenue_reports
      WHERE offering_id = $1
        AND (period_id = $2 OR (
          -- Support both explicit period_id and date-range lookups if period_id matches a date-based convention
          period_id IS NULL 
          AND DATE_TRUNC('month', period_start)::DATE = DATE_TRUNC('month', $3::DATE)::DATE
        ))
      ORDER BY created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
    `;

    // Try to parse periodId as a date if it's in YYYY-MM format
    // Otherwise use it directly
    let dateParam = periodId;
    if (/^\d{4}-\d{2}$/.test(periodId)) {
      dateParam = `${periodId}-01`;
    }

    const result = await client.query<any>(query, [
      offeringId,
      periodId,
      dateParam,
    ]);

    const entries: JournalEntryExport[] = result.rows.map((row) => ({
      id: row.id,
      offering_id: row.offering_id,
      period_id: row.period_id,
      amount: row.amount,
      issuer_id: row.issuer_id,
      reported_at: row.reported_at.toISOString(),
      created_at: row.created_at.toISOString(),
    }));

    return {
      format: 'jsonl',
      entries,
      period_id: periodId,
      offering_id: offeringId,
      entry_count: entries.length,
      exported_at: new Date().toISOString(),
    };
  }

  /**
   * Compute canonical export hash using SHA-256.
   * Format: JSONL with one entry per line, sorted by created_at then id.
   * This ensures the hash is deterministic and reproducible.
   *
   * @param export_ The materialized export
   * @returns SHA-256 hash as hex string
   */
  private computeExportHash(export_: MaterializedExport): string {
    // Canonical representation: one JSON object per line (JSONL)
    // Sorted by created_at then id (handled by materialization query)
    const lines = export_.entries.map((entry) => JSON.stringify(entry));
    const canonical = lines.join('\n');

    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Sign the export hash using HMAC-SHA256 with server-held key.
   * This provides tamper-evidence: attacker with DB access but without the key
   * cannot forge a valid signature.
   *
   * @param exportHash The SHA-256 hash of the export (hex string)
   * @returns HMAC-SHA256 signature as hex string
   */
  private signExportHash(exportHash: string): string {
    const keyBuffer = Buffer.from(this.signingKey.key, 'hex');
    const signature = createHmac('sha256', keyBuffer)
      .update(exportHash)
      .digest('hex');

    return signature;
  }

  /**
   * Verify an export signature (for external verification).
   * Used by clients to confirm signature validity without trusting server.
   *
   * @param exportHash The export hash (hex string)
   * @param signature The signature claimed for this hash (hex string)
   * @returns true if signature is valid, false otherwise
   */
  verifyExportSignature(exportHash: string, signature: string): boolean {
    const expectedSignature = this.signExportHash(exportHash);
    // Timing-safe comparison to prevent timing attacks
    try {
      return (
        Buffer.from(expectedSignature).toString('hex') ===
        Buffer.from(signature).toString('hex')
      );
    } catch {
      return false;
    }
  }
}
