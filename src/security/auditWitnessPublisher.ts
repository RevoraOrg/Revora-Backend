import { Pool } from 'pg';
import { globalMetrics } from '../lib/metrics';
import { globalLogger, Logger } from '../lib/logger';
import { WitnessClient, WitnessReceipt } from './witnessClient';

export interface AuditWitnessPublisherOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  logger?: Logger;
  metrics?: typeof globalMetrics;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;

export class AuditWitnessPublisher {
  private readonly logger: Logger;
  private readonly metrics: typeof globalMetrics;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly witnessClient: WitnessClient,
    options: AuditWitnessPublisherOptions = {},
  ) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? globalMetrics;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /**
   * Check if the headHash needs publishing, and if so, publish and record receipt.
   * Tolerates witness downtime by catching errors and alerting.
   */
  async publishLatest(headHash: string | null): Promise<void> {
    if (!headHash) {
      this.logger.debug('No head hash to publish');
      return;
    }

    try {
      const lastPublished = await this.getLastPublishedHash();
      
      if (lastPublished === headHash) {
        this.logger.debug('Hash already published', { headHash });
        return;
      }

      const receipt = await this.publishWithRetry(headHash);
      await this.saveReceipt(receipt);
      
      this.metrics.incrementCounter('audit.witness.published');
      this.logger.info('Audit log Merkle root published to witness', {
        headHash,
        witnessType: receipt.witnessType,
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics.incrementCounter('audit.witness.publish_errors');
      this.logger.error('ALARM: Failed to publish audit root to witness', {
        severity: 'high',
        alarm: 'audit_witness_publish_failure',
        headHash,
        error: message,
      });
      // We do not rethrow the error because witness downtime should not break local integrity checks.
    }
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
      ]
    );
  }

  private async publishWithRetry(headHash: string): Promise<WitnessReceipt> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        return await this.witnessClient.publish(headHash);
      } catch (error) {
        attempt++;
        if (attempt > this.maxRetries) {
          throw error; // exhausted
        }
        
        const delay = this.baseBackoffMs * Math.pow(2, attempt - 1);
        this.logger.warn(`Witness publish attempt ${attempt} failed, retrying in ${delay}ms`, { error: String(error) });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Unreachable');
  }
}
