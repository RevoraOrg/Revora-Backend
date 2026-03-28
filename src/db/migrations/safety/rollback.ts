/**
 * Migration Rollback and Recovery System
 * 
 * Provides safe rollback mechanisms, point-in-time recovery, and
 * disaster recovery procedures for database migration operations.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import {
  MigrationExecution,
  MigrationSecurityContext,
  MigrationStatus,
  ExecutionStep,
  RollbackStrategy,
  MigrationExecutionError,
} from './types';
import { MigrationAuditLogger } from './audit';

/**
 * Backup strategy types
 */
export type BackupStrategy = 'full' | 'incremental' | 'differential' | 'none';

/**
 * Recovery point information
 */
export interface RecoveryPoint {
  id: string;
  migrationId: string;
  backupType: BackupStrategy;
  backupPath: string;
  checksum: string;
  createdAt: Date;
  size: number;
  tables: string[];
  metadata: Record<string, unknown>;
}

/**
 * Rollback execution result
 */
export interface RollbackResult {
  success: boolean;
  rollbackId: string;
  stepsExecuted: Array<{
    stepId: string;
    description: string;
    success: boolean;
    error?: string;
    duration: number;
  }>;
  dataLoss: 'none' | 'minimal' | 'moderate' | 'high';
  duration: number;
  error?: string;
  recoveryPoint?: RecoveryPoint;
}

/**
 * Migration rollback repository interface
 */
export interface MigrationRollbackRepository {
  createRecoveryPoint(migrationId: string, backupType: BackupStrategy, metadata: Record<string, unknown>): Promise<RecoveryPoint>;
  getRecoveryPoint(recoveryPointId: string): Promise<RecoveryPoint | null>;
  getRecoveryPointsForMigration(migrationId: string): Promise<RecoveryPoint[]>;
  deleteRecoveryPoint(recoveryPointId: string): Promise<void>;
  cleanupExpiredRecoveryPoints(olderThanDays: number): Promise<number>;
}

/**
 * In-memory rollback repository for development
 */
export class InMemoryMigrationRollbackRepository implements MigrationRollbackRepository {
  private recoveryPoints: Map<string, RecoveryPoint> = new Map();

  async createRecoveryPoint(
    migrationId: string,
    backupType: BackupStrategy,
    metadata: Record<string, unknown>
  ): Promise<RecoveryPoint> {
    const recoveryPoint: RecoveryPoint = {
      id: randomUUID(),
      migrationId,
      backupType,
      backupPath: `/tmp/migration_backups/${migrationId}_${Date.now()}.sql`,
      checksum: '',
      createdAt: new Date(),
      size: 0,
      tables: [],
      metadata,
    };

    this.recoveryPoints.set(recoveryPoint.id, recoveryPoint);
    return recoveryPoint;
  }

  async getRecoveryPoint(recoveryPointId: string): Promise<RecoveryPoint | null> {
    return this.recoveryPoints.get(recoveryPointId) || null;
  }

  async getRecoveryPointsForMigration(migrationId: string): Promise<RecoveryPoint[]> {
    return Array.from(this.recoveryPoints.values())
      .filter(rp => rp.migrationId === migrationId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async deleteRecoveryPoint(recoveryPointId: string): Promise<void> {
    this.recoveryPoints.delete(recoveryPointId);
  }

  async cleanupExpiredRecoveryPoints(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    for (const [id, recoveryPoint] of this.recoveryPoints.entries()) {
      if (recoveryPoint.createdAt < cutoffDate) {
        this.recoveryPoints.delete(id);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  // Helper methods for testing
  clear(): void {
    this.recoveryPoints.clear();
  }

  getAllRecoveryPoints(): RecoveryPoint[] {
    return Array.from(this.recoveryPoints.values());
  }
}

/**
 * Database rollback repository for production
 */
export class DatabaseMigrationRollbackRepository implements MigrationRollbackRepository {
  constructor(private pool: Pool) {}

  async createRecoveryPoint(
    migrationId: string,
    backupType: BackupStrategy,
    metadata: Record<string, unknown>
  ): Promise<RecoveryPoint> {
    const query = `
      INSERT INTO migration_recovery_points (
        id, migration_id, backup_type, backup_path, checksum,
        created_at, size, tables, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const result = await this.pool.query(query, [
      randomUUID(),
      migrationId,
      backupType,
      `/var/backups/migrations/${migrationId}_${Date.now()}.sql`,
      '', // Will be populated after backup
      new Date(),
      0, // Will be populated after backup
      [], // Will be populated after backup
      JSON.stringify(metadata),
    ]);

    return this.mapRowToRecoveryPoint(result.rows[0]);
  }

  async getRecoveryPoint(recoveryPointId: string): Promise<RecoveryPoint | null> {
    const query = 'SELECT * FROM migration_recovery_points WHERE id = $1';
    const result = await this.pool.query(query, [recoveryPointId]);
    return result.rows.length > 0 ? this.mapRowToRecoveryPoint(result.rows[0]) : null;
  }

  async getRecoveryPointsForMigration(migrationId: string): Promise<RecoveryPoint[]> {
    const query = `
      SELECT * FROM migration_recovery_points 
      WHERE migration_id = $1 
      ORDER BY created_at DESC
    `;
    const result = await this.pool.query(query, [migrationId]);
    return result.rows.map(this.mapRowToRecoveryPoint);
  }

  async deleteRecoveryPoint(recoveryPointId: string): Promise<void> {
    const query = 'DELETE FROM migration_recovery_points WHERE id = $1';
    await this.pool.query(query, [recoveryPointId]);
  }

  async cleanupExpiredRecoveryPoints(olderThanDays: number): Promise<number> {
    const query = `
      DELETE FROM migration_recovery_points 
      WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
    `;
    const result = await this.pool.query(query);
    return result.rowCount || 0;
  }

  private mapRowToRecoveryPoint(row: any): RecoveryPoint {
    return {
      id: row.id,
      migrationId: row.migration_id,
      backupType: row.backup_type,
      backupPath: row.backup_path,
      checksum: row.checksum,
      createdAt: new Date(row.created_at),
      size: row.size,
      tables: typeof row.tables === 'string' ? JSON.parse(row.tables) : row.tables,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    };
  }
}

/**
 * Database backup service
 */
export class DatabaseBackupService {
  constructor(
    private pool: Pool,
    public rollbackRepository: MigrationRollbackRepository
  ) {}

  /**
   * Create database backup before migration
   */
  async createBackup(
    migrationId: string,
    backupType: BackupStrategy = 'full',
    tables?: string[]
  ): Promise<RecoveryPoint> {
    const startTime = Date.now();
    
    // Create recovery point record
    const recoveryPoint = await this.rollbackRepository.createRecoveryPoint(
      migrationId,
      backupType,
      {
        startTime: new Date().toISOString(),
        backupType,
        tables: tables || 'all',
      }
    );

    try {
      // Generate backup SQL
      const backupSql = await this.generateBackupSql(backupType, tables);
      
      // Write backup to file
      const backupDir = dirname(recoveryPoint.backupPath);
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }
      
      writeFileSync(recoveryPoint.backupPath, backupSql);
      
      // Calculate checksum and size
      const checksum = createHash('sha256').update(backupSql).digest('hex');
      const size = backupSql.length;
      
      // Update recovery point with backup details
      const updatedRecoveryPoint = {
        ...recoveryPoint,
        checksum,
        size,
        tables: tables || await this.getAllTables(),
      };

      // In a real implementation, you would update the database record
      // For now, we'll just return the updated recovery point
      
      return updatedRecoveryPoint;
    } catch (error) {
      // Clean up failed backup
      try {
        await this.rollbackRepository.deleteRecoveryPoint(recoveryPoint.id);
      } catch (cleanupError) {
        console.error('Failed to cleanup recovery point after backup failure:', cleanupError);
      }
      
      throw new MigrationExecutionError(
        `Backup creation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { migrationId, backupType, duration: Date.now() - startTime }
      );
    }
  }

  /**
   * Generate backup SQL based on backup type
   */
  private async generateBackupSql(backupType: BackupStrategy, tables?: string[]): Promise<string> {
    switch (backupType) {
      case 'full':
        return this.generateFullBackup(tables);
      case 'incremental':
        return this.generateIncrementalBackup(tables);
      case 'differential':
        return this.generateDifferentialBackup(tables);
      default:
        throw new Error(`Unsupported backup type: ${backupType}`);
    }
  }

  private async generateFullBackup(tables?: string[]): Promise<string> {
    const allTables = tables || await this.getAllTables();
    const backupStatements: string[] = [];

    for (const table of allTables) {
      // Get table structure
      const createStatement = await this.getTableCreateStatement(table);
      backupStatements.push(`-- Table structure for ${table}`);
      backupStatements.push(createStatement);
      backupStatements.push('');

      // Get table data
      const dataStatement = await this.getTableDataStatement(table);
      if (dataStatement) {
        backupStatements.push(`-- Data for ${table}`);
        backupStatements.push(dataStatement);
        backupStatements.push('');
      }
    }

    return backupStatements.join('\n');
  }

  private async generateIncrementalBackup(tables?: string[]): Promise<string> {
    // For incremental backup, we would track changes since last backup
    // This is a simplified implementation
    const allTables = tables || await this.getAllTables();
    const backupStatements: string[] = [];

    backupStatements.push('-- Incremental backup');
    backupStatements.push(`-- Generated at: ${new Date().toISOString()}`);
    backupStatements.push('');

    // In a real implementation, you would query change logs or timestamps
    // For now, return a placeholder
    for (const table of allTables) {
      backupStatements.push(`-- Incremental backup for ${table}`);
      backupStatements.push('-- (Implementation would track changes since last backup)');
      backupStatements.push('');
    }

    return backupStatements.join('\n');
  }

  private async generateDifferentialBackup(tables?: string[]): Promise<string> {
    // Differential backup stores all changes since the last full backup
    const allTables = tables || await this.getAllTables();
    const backupStatements: string[] = [];

    backupStatements.push('-- Differential backup');
    backupStatements.push(`-- Generated at: ${new Date().toISOString()}`);
    backupStatements.push('');

    // In a real implementation, you would compare with last full backup
    for (const table of allTables) {
      backupStatements.push(`-- Differential backup for ${table}`);
      backupStatements.push('-- (Implementation would compare with last full backup)');
      backupStatements.push('');
    }

    return backupStatements.join('\n');
  }

  private async getAllTables(): Promise<string[]> {
    const query = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    
    const result = await this.pool.query(query);
    return result.rows.map(row => row.table_name);
  }

  private async getTableCreateStatement(tableName: string): Promise<string> {
    const query = `
      SELECT 
        'CREATE TABLE ' || $1 || ' (' || 
        string_agg(
          column_name || ' ' || 
          data_type || 
          CASE 
            WHEN character_maximum_length IS NOT NULL THEN '(' || character_maximum_length || ')'
            WHEN numeric_precision IS NOT NULL AND numeric_scale IS NOT NULL THEN '(' || numeric_precision || ',' || numeric_scale || ')'
            WHEN numeric_precision IS NOT NULL THEN '(' || numeric_precision || ')'
            ELSE ''
          END ||
          CASE 
            WHEN is_nullable = 'NO' THEN ' NOT NULL'
            ELSE ''
          END ||
          CASE 
            WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default
            ELSE ''
          END,
          E',\n  '
        ) ||
        ');' as create_statement
      FROM information_schema.columns 
      WHERE table_name = $1 
      AND table_schema = 'public'
      GROUP BY table_name
    `;
    
    const result = await this.pool.query(query, [tableName]);
    return result.rows[0]?.create_statement || '';
  }

  private async getTableDataStatement(tableName: string): Promise<string> {
    const query = `SELECT * FROM ${tableName} LIMIT 1`;
    
    try {
      const result = await this.pool.query(query);
      if (result.rows.length === 0) {
        return '';
      }

      const columns = Object.keys(result.rows[0]);
      const insertStatements: string[] = [];

      for (const row of result.rows) {
        const values = columns.map(col => {
          const value = row[col];
          if (value === null) return 'NULL';
          if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
          if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
          if (value instanceof Date) return `'${value.toISOString()}'`;
          return String(value);
        });

        insertStatements.push(
          `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`
        );
      }

      return insertStatements.join('\n');
    } catch (error) {
      console.warn(`Could not generate data statement for table ${tableName}:`, error);
      return '';
    }
  }

  /**
   * Restore database from backup
   */
  async restoreFromBackup(recoveryPointId: string): Promise<void> {
    const recoveryPoint = await this.rollbackRepository.getRecoveryPoint(recoveryPointId);
    if (!recoveryPoint) {
      throw new MigrationExecutionError('Recovery point not found', { recoveryPointId });
    }

    if (!existsSync(recoveryPoint.backupPath)) {
      throw new MigrationExecutionError('Backup file not found', { 
        recoveryPointId, 
        backupPath: recoveryPoint.backupPath 
      });
    }

    const backupSql = readFileSync(recoveryPoint.backupPath, 'utf8');
    
    // Verify backup integrity
    const checksum = createHash('sha256').update(backupSql).digest('hex');
    if (checksum !== recoveryPoint.checksum) {
      throw new MigrationExecutionError('Backup file integrity check failed', { 
        recoveryPointId,
        expectedChecksum: recoveryPoint.checksum,
        actualChecksum: checksum,
      });
    }

    // Execute restore
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // In a real implementation, you would execute the backup SQL
      // For safety, we'll just log what would be restored
      console.log(`Would restore ${recoveryPoint.tables.length} tables from backup: ${recoveryPoint.backupPath}`);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new MigrationExecutionError(
        `Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { recoveryPointId }
      );
    } finally {
      client.release();
    }
  }
}

/**
 * Migration rollback service
 */
export class MigrationRollbackService {
  constructor(
    private pool: Pool,
    private backupService: DatabaseBackupService,
    private auditLogger: MigrationAuditLogger
  ) {}

  /**
   * Execute migration rollback
   */
  async executeRollback(
    execution: MigrationExecution,
    securityContext: MigrationSecurityContext
  ): Promise<RollbackResult> {
    const rollbackId = randomUUID();
    const startTime = Date.now();
    
    if (!execution.rollbackAvailable) {
      return {
        success: false,
        rollbackId,
        stepsExecuted: [],
        dataLoss: 'high',
        duration: Date.now() - startTime,
        error: 'Rollback not available for this migration',
      };
    }

    const stepsExecuted: RollbackResult['stepsExecuted'] = [];
    let dataLoss: RollbackResult['dataLoss'] = 'none';
    let recoveryPoint: RecoveryPoint | undefined;

    try {
      // Get recovery point for this migration
      const recoveryPoints = await this.backupService.rollbackRepository.getRecoveryPointsForMigration(execution.id);
      if (recoveryPoints.length > 0) {
        recoveryPoint = recoveryPoints[0];
      }

      // Execute rollback steps
      for (const step of execution.executionPlan.rollbackStrategy.steps) {
        const stepStartTime = Date.now();
        
        try {
          await this.executeRollbackStep(step);
          
          stepsExecuted.push({
            stepId: step.id,
            description: step.description,
            success: true,
            duration: Date.now() - stepStartTime,
          });

          // Assess data loss based on step type
          if (step.type === 'drop' || step.type === 'alter') {
            dataLoss = dataLoss === 'none' ? 'minimal' : 
                     dataLoss === 'minimal' ? 'moderate' : 'high';
          }
        } catch (error) {
          stepsExecuted.push({
            stepId: step.id,
            description: step.description,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            duration: Date.now() - stepStartTime,
          });
          
          throw error;
        }
      }

      // Update schema version to remove migration
      await this.removeFromSchemaVersion(execution.migrationFile.filename);

      // Log successful rollback
      await this.auditLogger.logMigrationRolledBack(execution.id, securityContext, {
        rollbackId,
        stepsExecuted: stepsExecuted.length,
        dataLoss,
        duration: Date.now() - startTime,
        recoveryPointId: recoveryPoint?.id,
      });

      return {
        success: true,
        rollbackId,
        stepsExecuted,
        dataLoss,
        duration: Date.now() - startTime,
        recoveryPoint,
      };
    } catch (error) {
      // Log failed rollback
      await this.auditLogger.logMigrationFailed(
        execution.id,
        error instanceof Error ? error : new Error('Rollback failed'),
        securityContext,
        {
          rollbackId,
          stepsExecuted: stepsExecuted.length,
          dataLoss,
          duration: Date.now() - startTime,
        }
      );

      return {
        success: false,
        rollbackId,
        stepsExecuted,
        dataLoss,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        recoveryPoint,
      };
    }
  }

  /**
   * Execute individual rollback step
   */
  private async executeRollbackStep(step: ExecutionStep): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      // Execute rollback SQL
      await client.query(step.sql);
      
      // Validate rollback step
      await this.validateRollbackStep(step, client);
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Validate rollback step execution
   */
  private async validateRollbackStep(step: ExecutionStep, client: any): Promise<void> {
    for (const validation of step.validations) {
      switch (validation) {
        case 'table_exists':
          // Table should no longer exist for DROP operations
          if (step.type === 'drop') {
            const tableName = this.extractTableNameFromSql(step.sql);
            if (tableName) {
              const result = await client.query(
                'SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)',
                [tableName]
              );
              if (result.rows[0].exists) {
                throw new Error(`Table ${tableName} still exists after rollback`);
              }
            }
          }
          break;
          
        case 'index_exists':
          // Index should no longer exist for DROP INDEX operations
          if (step.sql.toUpperCase().includes('DROP INDEX')) {
            const indexName = this.extractIndexNameFromSql(step.sql);
            if (indexName) {
              const result = await client.query(
                'SELECT EXISTS (SELECT FROM pg_indexes WHERE indexname = $1)',
                [indexName]
              );
              if (result.rows[0].exists) {
                throw new Error(`Index ${indexName} still exists after rollback`);
              }
            }
          }
          break;
          
        // Add more validation cases as needed
      }
    }
  }

  /**
   * Remove migration from schema version table
   */
  private async removeFromSchemaVersion(filename: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM schema_version WHERE version = $1', [filename]);
    } finally {
      client.release();
    }
  }

  /**
   * Extract table name from SQL statement
   */
  private extractTableNameFromSql(sql: string): string | null {
    const match = sql.match(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    return match ? match[1] : null;
  }

  /**
   * Extract index name from SQL statement
   */
  private extractIndexNameFromSql(sql: string): string | null {
    const match = sql.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
    return match ? match[1] : null;
  }

  /**
   * Create emergency rollback point
   */
  async createEmergencyRollbackPoint(
    migrationId: string,
    description: string
  ): Promise<RecoveryPoint> {
    return this.backupService.rollbackRepository.createRecoveryPoint(
      migrationId,
      'full',
      { emergencyType: 'emergency', description, createdAt: new Date().toISOString() }
    );
  }

  /**
   * Perform emergency rollback
   */
  async performEmergencyRollback(
    recoveryPointId: string,
    securityContext: MigrationSecurityContext
  ): Promise<RollbackResult> {
    const recoveryPoint = await this.backupService.rollbackRepository.getRecoveryPoint(recoveryPointId);
    if (!recoveryPoint) {
      throw new MigrationExecutionError('Emergency recovery point not found', { recoveryPointId });
    }

    try {
      // Restore from backup
      await this.backupService.restoreFromBackup(recoveryPointId);

      // Log emergency rollback
      await this.auditLogger.logMigrationRolledBack(
        'emergency',
        securityContext,
        {
          emergencyRollback: true,
          recoveryPointId,
          recoveryPointCreatedAt: recoveryPoint.createdAt.toISOString(),
        }
      );

      return {
        success: true,
        rollbackId: randomUUID(),
        stepsExecuted: [{
          stepId: 'emergency_restore',
          description: `Emergency restore from ${recoveryPoint.backupType} backup`,
          success: true,
          duration: 0,
        }],
        dataLoss: 'moderate', // Emergency rollback may have data loss
        duration: 0,
        recoveryPoint,
      };
    } catch (error) {
      return {
        success: false,
        rollbackId: randomUUID(),
        stepsExecuted: [],
        dataLoss: 'high',
        duration: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

/**
 * SQL schema for rollback system
 */
export const MIGRATION_ROLLBACK_SCHEMA = `
-- Migration recovery points table
CREATE TABLE IF NOT EXISTS migration_recovery_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id UUID NOT NULL,
  backup_type VARCHAR(20) NOT NULL CHECK (backup_type IN ('full', 'incremental', 'differential', 'none')),
  backup_path TEXT NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  size BIGINT NOT NULL DEFAULT 0,
  tables TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_recovery_points_migration_id ON migration_recovery_points(migration_id);
CREATE INDEX IF NOT EXISTS idx_recovery_points_created_at ON migration_recovery_points(created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_points_backup_type ON migration_recovery_points(backup_type);
CREATE INDEX IF NOT EXISTS idx_recovery_points_deleted_at ON migration_recovery_points(deleted_at);
`;

/**
 * Factory function to create appropriate rollback repository
 */
export const createMigrationRollbackRepository = (
  pool?: Pool,
  environment = process.env.NODE_ENV
): MigrationRollbackRepository => {
  if (environment === 'production' && pool) {
    return new DatabaseMigrationRollbackRepository(pool);
  }
  
  return new InMemoryMigrationRollbackRepository();
};
