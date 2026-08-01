/**
 * @file auditWitnessPublisher.ts
 *
 * @notice Publishes the Merkle root of the day's audit log to a public witness
 *         and persists the receipt (issue #721).
 *
 * @dev Flow:
 *        1. Load that day's `row_hash` values from `audit_logs` (ordered).
 *        2. Compute the Merkle root via `computeMerkleRoot`.
 *        3. Skip if the same root was already published.
 *        4. Publish with bounded exponential backoff; alert on exhaustion.
 *        5. Persist the receipt in `audit_witness_receipts`.
 *        6. Emit `audit.witness.published`.
 *
 *      Witness downtime must NEVER break local integrity verification — all
 *      publish errors are caught, logged as ALARMs, and swallowed.
 */

import { Pool } from 'pg';
import { globalMetrics } from '../lib/metrics';
import { globalLogger, Logger } from '../lib/logger';
import { WitnessClient, WitnessReceipt } from './witnessClient';
import { computeMerkleRoot, utcDayBounds } from './auditMerkle';

export interface AuditWitnessPublisherOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  logger?: Logger;
  metrics?: typeof globalMetrics;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;

export class AuditWitnessPublisher {
  private readonly logger: Logger;
  private readonly metrics: typeof globalMetrics;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly witnessClient: WitnessClient,
    options: AuditWitnessPublisherOptions = {},
  ) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? globalMetrics;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Compute the Merkle root of yesterday's (or `day`'s) audit rows and publish
   * it to the configured public witness.
   *
   * @param day Optional UTC day to witness. Defaults to the previous UTC day
   *            so the nightly job always witnesses a complete day.
   */
  async publishDayRoot(day?: Date): Promise<void> {
    const target = day ?? this.previousUtcDay();
    try {
      const leaves = await this.loadDayRowHashes(target);
      const root = computeMerkleRoot(leaves);

      if (!root) {
        this.logger.debug('No audit rows for day — nothing to witness', {
          day: target.toISOString().slice(0, 10),
        });
        return;
      }

      await this.publishRoot(root, {
        day: target.toISOString().slice(0, 10),
        leafCount: leaves.length,
      });
    } catch (error) {
      // Local integrity must survive witness/DB failures.
      this.recordPublishFailure(error, null);
    }
  }

  /**
   * Publish an already-known head/root hash (used by the integrity scheduler
   * after a successful full-chain verification).
   */
  async publishLatest(headHash: string | null): Promise<void> {
    if (!headHash) {
      this.logger.debug('No head hash to publish');
      return;
    }
    try {
      await this.publishRoot(headHash, { source: 'chain_head' });
    } catch (error) {
      this.recordPublishFailure(error, headHash);
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private previousUtcDay(): Date {
    const now = this.now();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  }

  private async loadDayRowHashes(day: Date): Promise<string[]> {
    const { start, end } = utcDayBounds(day);
    const res = await this.pool.query<{ row_hash: string }>(
      `
      SELECT row_hash
        FROM audit_logs
       WHERE created_at >= $1 AND created_at < $2
         AND row_hash IS NOT NULL
       ORDER BY created_at ASC, id ASC
      `,
      [start, end],
    );
    return res.rows.map((r) => r.row_hash);
  }

  private async publishRoot(
    rootHash: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const lastPublished = await this.getLastPublishedHash();
    if (lastPublished === rootHash) {
      this.logger.debug('Hash already published', { rootHash, ...context });
      return;
    }

    const receipt = await this.publishWithRetry(rootHash);
    await this.saveReceipt(receipt);

    this.metrics.incrementCounter(
      'audit.witness.published',
      undefined,
      1,
      'Number of audit Merkle roots successfully published to a public witness',
    );
    this.logger.info('Audit log Merkle root published to witness', {
      rootHash,
      witnessType: receipt.witnessType,
      ...context,
    });
  }

  private async getLastPublishedHash(): Promise<string | null> {
    const res = await this.pool.query(`
      SELECT root_hash FROM audit_witness_receipts
      ORDER BY created_at DESC
      LIMIT 1
    `);
    if (res.rows.length === 0) return null;
    return res.rows[0].root_hash;
  }

  private async saveReceipt(receipt: WitnessReceipt): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO audit_witness_receipts (root_hash, witness_type, receipt_data, published_at)
      VALUES ($1, $2, $3, $4)
      `,
      [
        receipt.rootHash,
        receipt.witnessType,
        JSON.stringify(receipt.receiptData),
        receipt.publishedAt,
      ],
    );
  }

  private async publishWithRetry(rootHash: string): Promise<WitnessReceipt> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        return await this.witnessClient.publish(rootHash);
      } catch (error) {
        attempt++;
        if (attempt > this.maxRetries) {
          throw error;
        }
        const delay = this.baseBackoffMs * Math.pow(2, attempt - 1);
        this.logger.warn(`Witness publish attempt ${attempt} failed, retrying in ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable');
  }

  private recordPublishFailure(error: unknown, rootHash: string | null): void {
    const message = error instanceof Error ? error.message : String(error);
    this.metrics.incrementCounter(
      'audit.witness.publish_errors',
      undefined,
      1,
      'Number of exhausted audit witness publish attempts',
    );
    this.logger.error('ALARM: Failed to publish audit root to witness', {
      severity: 'high',
      alarm: 'audit_witness_publish_failure',
      rootHash,
      error: message,
    });
  }
}
