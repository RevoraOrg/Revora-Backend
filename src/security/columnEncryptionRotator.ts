/**
 * Column Encryption Rotator Service
 * 
 * Provides background re-encryption of column-level data at rest during KMS key rotation drills.
 * Tracks per-row key generations, maintains persisted resumable state, emits metrics,
 * and records security audit events.
 */

import { Pool } from 'pg';
import { KMSKeyProvider } from './kmsKeyProvider';
import { KMSRotationJobState, KMSRotationOptions, SecurityAuditRepository, AuditEvent } from './types';
import { InMemorySecurityAuditRepository } from './audit';
import { globalMetrics, MetricsCollector } from '../lib/metrics';
import { globalLogger, Logger } from '../lib/logger';

export interface ColumnEncryptionRotatorOptions {
  pool?: Pick<Pool, 'query'>;
  kmsKeyProvider: KMSKeyProvider;
  auditRepo?: SecurityAuditRepository;
  metrics?: MetricsCollector;
  logger?: Logger;
  /** In-memory records store for testing without PostgreSQL DB */
  inMemoryStore?: Array<{ id: string; sensitiveData: string; keyGeneration: number }>;
}

export class ColumnEncryptionRotator {
  private readonly pool?: Pick<Pool, 'query'>;
  private readonly kmsKeyProvider: KMSKeyProvider;
  private readonly auditRepo: SecurityAuditRepository;
  private readonly metrics: MetricsCollector;
  private readonly logger: Logger;
  private readonly inMemoryJobs: Map<string, KMSRotationJobState> = new Map();
  private readonly inMemoryStore?: Array<{ id: string; sensitiveData: string; keyGeneration: number }>;

  constructor(options: ColumnEncryptionRotatorOptions) {
    this.pool = options.pool;
    this.kmsKeyProvider = options.kmsKeyProvider;
    this.auditRepo = options.auditRepo ?? new InMemorySecurityAuditRepository();
    this.metrics = options.metrics ?? globalMetrics;
    this.logger = options.logger ?? globalLogger;
    this.inMemoryStore = options.inMemoryStore;
  }

  /**
   * Start or resume a column encryption rotation job.
   */
  async startRotation(
    targetTable: string,
    targetColumn: string,
    options: KMSRotationOptions = {}
  ): Promise<KMSRotationJobState> {
    const targetKeyGeneration = options.targetKeyGeneration ?? this.kmsKeyProvider.getCurrentKeyGeneration();
    const jobId = `${targetTable}:${targetColumn}:gen${targetKeyGeneration}`;

    let state = await this.getJobState(jobId);

    if (!state) {
      const totalRows = await this.countRowsToRotate(targetTable, targetColumn, targetKeyGeneration);
      state = {
        id: jobId,
        targetTable,
        targetColumn,
        targetKeyGeneration,
        lastProcessedId: null,
        status: totalRows === 0 ? 'completed' : 'pending',
        totalRows,
        reencryptedRows: 0,
        failedRows: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: totalRows === 0 ? new Date() : null,
      };

      await this.saveJobState(state);

      await this.recordAudit('KMS_KEY_ROTATION_STARTED', 'SUCCESS', {
        jobId,
        targetTable,
        targetColumn,
        targetKeyGeneration,
        totalRows: state.totalRows,
      });
    }

    if (state.status === 'completed') {
      return state;
    }

    state.status = 'in_progress';
    state.updatedAt = new Date();
    await this.saveJobState(state);

    return state;
  }

  /**
   * Process a single batch of rows needing re-encryption for a job.
   * Crucial safety guarantee: Only queries rows where key_generation < targetKeyGeneration.
   * Ensures that crash recovery mid-batch skips already re-encrypted rows without double re-encrypting.
   */
  async processBatch(jobId: string, batchSize = 100): Promise<{ processed: number; completed: boolean }> {
    const state = await this.getJobState(jobId);
    if (!state) {
      throw new Error(`KMS rotation job ${jobId} not found`);
    }

    if (state.status === 'completed') {
      return { processed: 0, completed: true };
    }

    const rowsToProcess = await this.fetchBatchToRotate(
      state.targetTable,
      state.targetColumn,
      state.targetKeyGeneration,
      state.lastProcessedId,
      batchSize
    );

    if (rowsToProcess.length === 0) {
      state.status = 'completed';
      state.completedAt = new Date();
      state.updatedAt = new Date();
      await this.saveJobState(state);

      await this.recordAudit('KMS_KEY_ROTATION_COMPLETED', 'SUCCESS', {
        jobId,
        targetTable: state.targetTable,
        targetColumn: state.targetColumn,
        targetKeyGeneration: state.targetKeyGeneration,
        totalReencrypted: state.reencryptedRows,
        totalFailed: state.failedRows,
      });

      return { processed: 0, completed: true };
    }

    let processedCount = 0;
    let lastId = state.lastProcessedId;

    for (const row of rowsToProcess) {
      try {
        // Double re-encryption prevention check: verify row's keyGeneration < targetKeyGeneration
        if (row.keyGeneration >= state.targetKeyGeneration) {
          lastId = row.id;
          continue;
        }

        // Decrypt with row's current key generation
        const plaintext = await this.kmsKeyProvider.decrypt(row.ciphertext, row.keyGeneration);

        // Re-encrypt with target KMS key generation
        const encrypted = await this.kmsKeyProvider.encrypt(plaintext, state.targetKeyGeneration);

        // Save re-encrypted column value and new key generation to persistence
        await this.updateRowEncryption(
          state.targetTable,
          state.targetColumn,
          row.id,
          encrypted.ciphertext,
          encrypted.keyGeneration
        );

        // Emit required metric counter: rotation.rows_reencrypted
        this.metrics.incrementCounter('rotation.rows_reencrypted', {
          table: state.targetTable,
          column: state.targetColumn,
        }, 1, 'Counter of rows successfully re-encrypted during KMS key rotation');

        processedCount++;
        state.reencryptedRows++;
        lastId = row.id;
      } catch (error) {
        state.failedRows++;
        this.logger.error('Failed to re-encrypt row during KMS key rotation', {
          jobId,
          rowId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.recordAudit('KMS_ROW_REENCRYPT_FAILED', 'FAILURE', {
          jobId,
          rowId: row.id,
          table: state.targetTable,
          column: state.targetColumn,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    state.lastProcessedId = lastId;
    state.updatedAt = new Date();

    // Check if remaining rows exist
    const remaining = await this.countRowsToRotate(state.targetTable, state.targetColumn, state.targetKeyGeneration);
    if (remaining === 0) {
      state.status = 'completed';
      state.completedAt = new Date();
      await this.saveJobState(state);

      await this.recordAudit('KMS_KEY_ROTATION_COMPLETED', 'SUCCESS', {
        jobId,
        targetTable: state.targetTable,
        targetColumn: state.targetColumn,
        targetKeyGeneration: state.targetKeyGeneration,
        totalReencrypted: state.reencryptedRows,
        totalFailed: state.failedRows,
      });

      return { processed: processedCount, completed: true };
    }

    await this.saveJobState(state);

    await this.recordAudit('KMS_KEY_ROTATION_PROGRESS', 'SUCCESS', {
      jobId,
      batchProcessed: processedCount,
      totalReencrypted: state.reencryptedRows,
      remainingRows: remaining,
    });

    return { processed: processedCount, completed: false };
  }

  /**
   * Run entire rotation job to completion in batches.
   */
  async runToCompletion(jobId: string, batchSize = 100): Promise<KMSRotationJobState> {
    let completed = false;
    while (!completed) {
      const res = await this.processBatch(jobId, batchSize);
      completed = res.completed;
    }
    return (await this.getJobState(jobId))!;
  }

  /**
   * Resume all unfinished (pending or in_progress) KMS rotation jobs.
   */
  async resumePendingRotations(batchSize = 100): Promise<KMSRotationJobState[]> {
    const jobs = await this.listUnfinishedJobs();
    const updatedJobs: KMSRotationJobState[] = [];

    for (const job of jobs) {
      this.logger.info('Resuming KMS rotation job', { jobId: job.id });
      const finalState = await this.runToCompletion(job.id, batchSize);
      updatedJobs.push(finalState);
    }

    return updatedJobs;
  }

  /**
   * Fetch current job state.
   */
  async getJobState(jobId: string): Promise<KMSRotationJobState | null> {
    if (this.pool) {
      const query = `SELECT * FROM kms_rotation_state WHERE id = $1`;
      const result = await this.pool.query(query, [jobId]);
      if (result.rows.length === 0) return null;
      return this.mapDbRowToState(result.rows[0]);
    }

    return this.inMemoryJobs.get(jobId) ?? null;
  }

  private async saveJobState(state: KMSRotationJobState): Promise<void> {
    if (this.pool) {
      const query = `
        INSERT INTO kms_rotation_state (
          id, target_table, target_column, target_key_generation, 
          last_processed_id, status, total_rows, reencrypted_rows, 
          failed_rows, created_at, updated_at, completed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          last_processed_id = EXCLUDED.last_processed_id,
          status = EXCLUDED.status,
          reencrypted_rows = EXCLUDED.reencrypted_rows,
          failed_rows = EXCLUDED.failed_rows,
          updated_at = EXCLUDED.updated_at,
          completed_at = EXCLUDED.completed_at;
      `;
      await this.pool.query(query, [
        state.id,
        state.targetTable,
        state.targetColumn,
        state.targetKeyGeneration,
        state.lastProcessedId,
        state.status,
        state.totalRows,
        state.reencryptedRows,
        state.failedRows,
        state.createdAt,
        state.updatedAt,
        state.completedAt,
      ]);
    } else {
      this.inMemoryJobs.set(state.id, { ...state });
    }
  }

  private async countRowsToRotate(table: string, column: string, targetKeyGen: number): Promise<number> {
    if (this.pool) {
      const query = `SELECT COUNT(*)::int AS count FROM ${table} WHERE key_generation < $1 OR key_generation IS NULL`;
      const result = await this.pool.query(query, [targetKeyGen]);
      return result.rows[0]?.count ?? 0;
    }

    if (this.inMemoryStore) {
      return this.inMemoryStore.filter((r) => r.keyGeneration < targetKeyGen).length;
    }

    return 0;
  }

  private async fetchBatchToRotate(
    table: string,
    column: string,
    targetKeyGen: number,
    lastProcessedId: string | null,
    batchSize: number
  ): Promise<Array<{ id: string; ciphertext: string; keyGeneration: number }>> {
    if (this.pool) {
      let query = `
        SELECT id, ${column} AS ciphertext, key_generation
        FROM ${table}
        WHERE (key_generation < $1 OR key_generation IS NULL)
      `;
      const params: any[] = [targetKeyGen];

      if (lastProcessedId) {
        query += ` AND id > $2 ORDER BY id ASC LIMIT $3`;
        params.push(lastProcessedId, batchSize);
      } else {
        query += ` ORDER BY id ASC LIMIT $2`;
        params.push(batchSize);
      }

      const result = await this.pool.query(query, params);
      return result.rows.map((r: any) => ({
        id: r.id,
        ciphertext: r.ciphertext,
        keyGeneration: r.key_generation ?? 1,
      }));
    }

    if (this.inMemoryStore) {
      let filtered = this.inMemoryStore.filter((r) => r.keyGeneration < targetKeyGen);
      filtered.sort((a, b) => a.id.localeCompare(b.id));

      if (lastProcessedId) {
        filtered = filtered.filter((r) => r.id > lastProcessedId);
      }

      return filtered.slice(0, batchSize).map((r) => ({
        id: r.id,
        ciphertext: r.sensitiveData,
        keyGeneration: r.keyGeneration,
      }));
    }

    return [];
  }

  private async updateRowEncryption(
    table: string,
    column: string,
    id: string,
    newCiphertext: string,
    newKeyGen: number
  ): Promise<void> {
    if (this.pool) {
      const query = `
        UPDATE ${table}
        SET ${column} = $1, key_generation = $2, updated_at = NOW()
        WHERE id = $3
      `;
      await this.pool.query(query, [newCiphertext, newKeyGen, id]);
    }

    if (this.inMemoryStore) {
      const item = this.inMemoryStore.find((r) => r.id === id);
      if (item) {
        item.sensitiveData = newCiphertext;
        item.keyGeneration = newKeyGen;
      }
    }
  }

  private async listUnfinishedJobs(): Promise<KMSRotationJobState[]> {
    if (this.pool) {
      const query = `SELECT * FROM kms_rotation_state WHERE status IN ('pending', 'in_progress') ORDER BY created_at ASC`;
      const result = await this.pool.query(query);
      return result.rows.map((row: any) => this.mapDbRowToState(row));
    }

    return Array.from(this.inMemoryJobs.values()).filter(
      (j) => j.status === 'pending' || j.status === 'in_progress'
    );
  }

  private mapDbRowToState(row: any): KMSRotationJobState {
    return {
      id: row.id,
      targetTable: row.target_table,
      targetColumn: row.target_column,
      targetKeyGeneration: row.target_key_generation,
      lastProcessedId: row.last_processed_id,
      status: row.status,
      totalRows: parseInt(row.total_rows, 10),
      reencryptedRows: parseInt(row.reencrypted_rows, 10),
      failedRows: parseInt(row.failed_rows, 10),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }

  private async recordAudit(
    action: string,
    outcome: 'SUCCESS' | 'FAILURE',
    details: Record<string, unknown>
  ): Promise<void> {
    const event: AuditEvent = {
      id: `kms_rot_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'KEY_ROTATION',
      action,
      resource: 'kms_column_encryption',
      outcome,
      details,
      securityContext: {
        requestId: 'kms_rotator_service',
        ipAddress: '127.0.0.1',
        userAgent: 'ColumnEncryptionRotator/1.0',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    };

    await this.auditRepo.record(event);
  }
}
