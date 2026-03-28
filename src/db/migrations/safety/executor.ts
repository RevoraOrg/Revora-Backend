/**
 * Hardened Migration Execution Engine
 * 
 * Provides production-grade migration execution with comprehensive safety checks,
 * rollback capabilities, and security enforcement.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  MigrationFile,
  MigrationExecution,
  MigrationSecurityContext,
  MigrationSafetyConfig,
  MigrationStatus,
  MigrationExecutionError,
  MigrationValidationError,
  MigrationAuthorizationError,
  MigrationEnvironment,
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
} from './types';
import { MigrationFileAnalyzer, PreflightValidator, ExecutionPlanGenerator } from './validation';
import { MigrationAuditLogger, createMigrationAuditRepository } from './audit';
import { MigrationAccessControl, createMigrationApprovalRepository } from './accessControl';
import { MigrationRollbackService, DatabaseBackupService, createMigrationRollbackRepository } from './rollback';

/**
 * Migration execution options
 */
export interface MigrationExecutionOptions {
  dryRun?: boolean;
  force?: boolean;
  skipBackup?: boolean;
  timeout?: number;
  batchSize?: number;
}

/**
 * Migration execution result
 */
export interface MigrationExecutionResult {
  success: boolean;
  executionId: string;
  migrationFile: MigrationFile;
  status: MigrationStatus;
  startedAt: Date;
  completedAt?: Date;
  duration: number;
  stepsExecuted: number;
  error?: string;
  rollbackAvailable: boolean;
  recoveryPointId?: string;
  preflightChecks: Array<{
    name: string;
    status: 'passed' | 'failed' | 'warning';
    message: string;
    critical: boolean;
  }>;
}

/**
 * Hardened migration executor
 */
export class HardenedMigrationExecutor {
  private fileAnalyzer = new MigrationFileAnalyzer();
  private auditLogger: MigrationAuditLogger;
  private accessControl: MigrationAccessControl;
  private rollbackService: MigrationRollbackService;
  private backupService: DatabaseBackupService;

  constructor(
    private pool: Pool,
    private config: MigrationSafetyConfig = DEFAULT_MIGRATION_SAFETY_CONFIGS[
      (process.env.NODE_ENV as MigrationEnvironment) || 'development'
    ] || DEFAULT_MIGRATION_SAFETY_CONFIGS.development
  ) {
    const auditRepository = createMigrationAuditRepository(pool);
    this.auditLogger = new MigrationAuditLogger(auditRepository);
    
    const approvalRepository = createMigrationApprovalRepository(pool);
    this.accessControl = new MigrationAccessControl(approvalRepository, this.auditLogger, this.config);
    
    const rollbackRepository = createMigrationRollbackRepository(pool);
    this.backupService = new DatabaseBackupService(pool, rollbackRepository);
    this.rollbackService = new MigrationRollbackService(pool, this.backupService, this.auditLogger);
  }

  /**
   * Execute migration with comprehensive safety checks
   */
  async executeMigration(
    migrationPath: string,
    securityContext: MigrationSecurityContext,
    options: MigrationExecutionOptions = {}
  ): Promise<MigrationExecutionResult> {
    const startTime = Date.now();
    
    try {
      // 1. Load and analyze migration file
      const migrationFile = this.loadMigrationFile(migrationPath);
      
      // 2. Check execution permissions
      const permissionCheck = await this.accessControl.canExecuteMigration(
        securityContext,
        migrationFile.riskLevel
      );
      
      if (!permissionCheck.allowed) {
        throw new MigrationAuthorizationError(
          permissionCheck.reason || 'Migration execution not permitted',
          { migrationFile: migrationFile.filename, userRole: securityContext.userRole }
        );
      }

      // 3. Check approval requirements
      if (permissionCheck.approvalRequired) {
        const approvalCheck = await this.accessControl.hasValidApproval(
          migrationFile.filename,
          securityContext
        );
        
        if (!approvalCheck.approved) {
          throw new MigrationAuthorizationError(
            'Migration approval required but not found',
            { migrationFile: migrationFile.filename }
          );
        }
      }

      // 4. Create execution record
      const execution = await this.createExecutionRecord(migrationFile, securityContext);

      // 5. Run pre-flight checks
      const validator = new PreflightValidator(this.config, securityContext);
      const preflightChecks = await validator.validateMigration(migrationFile);
      
      const criticalFailures = preflightChecks.filter(check => check.status === 'failed' && check.critical);
      if (criticalFailures.length > 0 && !options.force) {
        throw new MigrationValidationError(
          `Critical pre-flight checks failed: ${criticalFailures.map(c => c.name).join(', ')}`,
          { criticalFailures }
        );
      }

      // 6. Generate execution plan
      const planGenerator = new ExecutionPlanGenerator();
      const executionPlan = planGenerator.generatePlan(migrationFile);

      // 7. Create backup if required
      let recoveryPointId: string | undefined;
      if (!options.skipBackup && (this.config.requireBackup || migrationFile.requiresBackup)) {
        const recoveryPoint = await this.backupService.rollbackRepository.createRecoveryPoint(
          execution.id,
          'full',
          { migrationFilename: migrationFile.filename, riskLevel: migrationFile.riskLevel }
        );
        recoveryPointId = recoveryPoint.id;
      }

      // 8. Execute migration (or dry run)
      if (options.dryRun) {
        return this.performDryRun(execution, preflightChecks, startTime);
      }

      const executionResult = await this.performExecution(
        execution,
        executionPlan,
        preflightChecks,
        startTime,
        options
      );

      return {
        ...executionResult,
        recoveryPointId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      
      await this.auditLogger.logMigrationFailed(
        'unknown',
        error instanceof Error ? error : new Error('Migration execution failed'),
        securityContext,
        { migrationPath, duration, options }
      );

      return {
        success: false,
        executionId: 'failed',
        migrationFile: {
          filename: migrationPath.split('/').pop() || 'unknown',
          filepath: migrationPath,
          content: '',
          checksum: '',
          size: 0,
          riskLevel: 'low',
          requiresDowntime: false,
          requiresBackup: false,
          dependencies: [],
        },
        status: 'failed',
        startedAt: new Date(startTime),
        duration,
        stepsExecuted: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
        rollbackAvailable: false,
        preflightChecks: [],
      };
    }
  }

  /**
   * Rollback migration
   */
  async rollbackMigration(
    executionId: string,
    securityContext: MigrationSecurityContext
  ): Promise<any> {
    // This would retrieve the execution record and perform rollback
    // For now, return a placeholder
    return this.rollbackService.executeRollback(
      {
        id: executionId,
        migrationFile: {
          filename: 'unknown',
          filepath: 'unknown',
          content: '',
          checksum: '',
          size: 0,
          riskLevel: 'low',
          requiresDowntime: false,
          requiresBackup: false,
          dependencies: [],
        },
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        rollbackAvailable: true,
        securityContext,
        preflightChecks: [],
        executionPlan: {
          steps: [],
          estimatedDuration: 0,
          requiresDowntime: false,
          rollbackStrategy: {
            available: false,
            automated: false,
            steps: [],
            dataLossRisk: 'none',
            estimatedRollbackTime: 0,
          },
          riskMitigations: [],
        },
      },
      securityContext
    );
  }

  /**
   * Get migration status
   */
  async getMigrationStatus(executionId: string): Promise<MigrationExecution | null> {
    // This would retrieve the execution record from the audit repository
    // For now, return a placeholder
    return null;
  }

  /**
   * Load and analyze migration file
   */
  private loadMigrationFile(migrationPath: string): MigrationFile {
    try {
      const filename = migrationPath.split('/').pop() || 'unknown';
      const content = readFileSync(migrationPath, 'utf8');
      
      return this.fileAnalyzer.analyzeFile(migrationPath, filename);
    } catch (error) {
      throw new MigrationExecutionError(
        `Failed to load migration file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        { migrationPath }
      );
    }
  }

  /**
   * Create execution record
   */
  private async createExecutionRecord(
    migrationFile: MigrationFile,
    securityContext: MigrationSecurityContext
  ): Promise<MigrationExecution> {
    const execution: MigrationExecution = {
      id: randomUUID(),
      migrationFile,
      status: 'pending',
      startedAt: new Date(),
      rollbackAvailable: false,
      securityContext,
      preflightChecks: [],
      executionPlan: {
        steps: [],
        estimatedDuration: 0,
        requiresDowntime: false,
        rollbackStrategy: {
          available: false,
          automated: false,
          steps: [],
          dataLossRisk: 'none',
          estimatedRollbackTime: 0,
        },
        riskMitigations: [],
      },
    };

    await this.auditLogger.logMigrationStarted(execution);
    return execution;
  }

  /**
   * Perform dry run
   */
  private async performDryRun(
    execution: MigrationExecution,
    preflightChecks: any[],
    startTime: number
  ): Promise<MigrationExecutionResult> {
    const planGenerator = new ExecutionPlanGenerator();
    const executionPlan = planGenerator.generatePlan(execution.migrationFile);

    return {
      success: true,
      executionId: execution.id,
      migrationFile: execution.migrationFile,
      status: 'completed',
      startedAt: execution.startedAt,
      completedAt: new Date(),
      duration: Date.now() - startTime,
      stepsExecuted: executionPlan.steps.length,
      rollbackAvailable: executionPlan.rollbackStrategy.available,
      preflightChecks,
    };
  }

  /**
   * Perform actual migration execution
   */
  private async performExecution(
    execution: MigrationExecution,
    executionPlan: any,
    preflightChecks: any[],
    startTime: number,
    options: MigrationExecutionOptions
  ): Promise<MigrationExecutionResult> {
    const client = await this.pool.connect();
    let stepsExecuted = 0;

    try {
      await client.query('BEGIN');

      // Execute each step in the plan
      for (const step of executionPlan.steps) {
        await this.executeStep(client, step, options);
        stepsExecuted++;
      }

      // Record migration in schema_version table
      await client.query(
        'INSERT INTO schema_version (version) VALUES ($1)',
        [execution.migrationFile.filename]
      );

      await client.query('COMMIT');

      // Update execution record
      await this.auditLogger.logMigrationCompleted(execution.id, execution.securityContext, {
        stepsExecuted,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        executionId: execution.id,
        migrationFile: execution.migrationFile,
        status: 'completed',
        startedAt: execution.startedAt,
        completedAt: new Date(),
        duration: Date.now() - startTime,
        stepsExecuted,
        rollbackAvailable: executionPlan.rollbackStrategy.available,
        preflightChecks,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      
      await this.auditLogger.logMigrationFailed(
        execution.id,
        error instanceof Error ? error : new Error('Migration execution failed'),
        execution.securityContext,
        { stepsExecuted, duration: Date.now() - startTime }
      );

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Execute individual migration step
   */
  private async executeStep(
    client: any,
    step: any,
    options: MigrationExecutionOptions
  ): Promise<void> {
    const timeout = options.timeout || this.config.maxMigrationDuration * 1000;
    
    // Execute with timeout
    await Promise.race([
      client.query(step.sql),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Step execution timeout')), timeout)
      )
    ]);
  }

  /**
   * Create approval request
   */
  async createApprovalRequest(
    migrationPath: string,
    securityContext: MigrationSecurityContext
  ): Promise<any> {
    const migrationFile = this.loadMigrationFile(migrationPath);
    
    return this.accessControl.createApprovalRequest(
      migrationFile.filename,
      migrationFile.filename,
      migrationFile.riskLevel,
      securityContext
    );
  }

  /**
   * Get pending approval requests
   */
  async getPendingApprovals(environment: string): Promise<any[]> {
    return this.accessControl.getPendingRequests(environment as any);
  }

  /**
   * Approve migration request
   */
  async approveMigration(
    requestId: string,
    approvedBy: string,
    approverRole: string,
    comments?: string
  ): Promise<void> {
    return this.accessControl.approveMigrationRequest(
      requestId,
      approvedBy,
      approverRole as any,
      comments
    );
  }

  /**
   * Reject migration request
   */
  async rejectMigration(
    requestId: string,
    rejectedBy: string,
    rejectorRole: string,
    comments?: string
  ): Promise<void> {
    return this.accessControl.rejectMigrationRequest(
      requestId,
      rejectedBy,
      rejectorRole as any,
      comments
    );
  }
}

/**
 * Migration manager for high-level operations
 */
export class MigrationManager {
  constructor(
    private pool: Pool,
    private environment: MigrationEnvironment = process.env.NODE_ENV as any || 'development'
  ) {
    this.ensureSchemaVersionTable();
  }

  private async ensureSchemaVersionTable(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);
    } finally {
      client.release();
    }
  }

  /**
   * Get applied migrations
   */
  async getAppliedMigrations(): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT version FROM schema_version ORDER BY version');
      return result.rows.map(row => row.version);
    } finally {
      client.release();
    }
  }

  /**
   * Get pending migrations
   */
  async getPendingMigrations(migrationsDir: string): Promise<string[]> {
    const fs = require('fs');
    const path = require('path');
    
    const appliedMigrations = await this.getAppliedMigrations();
    const appliedSet = new Set(appliedMigrations);
    
    const files = fs.readdirSync(migrationsDir)
      .filter((f: string) => f.endsWith('.sql'))
      .sort();
    
    return files.filter((file: string) => !appliedSet.has(file));
  }

  /**
   * Run all pending migrations with safety checks
   */
  async runPendingMigrations(
    securityContext: MigrationSecurityContext,
    options: MigrationExecutionOptions = {}
  ): Promise<MigrationExecutionResult[]> {
    const fs = require('fs');
    const path = require('path');
    
    const migrationsDir = path.join(__dirname, '../../../migrations');
    const pendingMigrations = await this.getPendingMigrations(migrationsDir);
    
    const executor = new HardenedMigrationExecutor(this.pool);
    const results: MigrationExecutionResult[] = [];
    
    for (const migration of pendingMigrations) {
      const migrationPath = path.join(migrationsDir, migration);
      
      try {
        const result = await executor.executeMigration(migrationPath, securityContext, options);
        results.push(result);
        
        if (!result.success && !options.force) {
          break; // Stop on first failure unless forced
        }
      } catch (error) {
        const result: MigrationExecutionResult = {
          success: false,
          executionId: 'failed',
          migrationFile: {
            filename: migration,
            filepath: migrationPath,
            content: '',
            checksum: '',
            size: 0,
            riskLevel: 'low',
            requiresDowntime: false,
            requiresBackup: false,
            dependencies: [],
          },
          status: 'failed',
          startedAt: new Date(),
          duration: 0,
          stepsExecuted: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
          rollbackAvailable: false,
          preflightChecks: [],
        };
        results.push(result);
        
        if (!options.force) {
          break;
        }
      }
    }
    
    return results;
  }
}

/**
 * Complete SQL schema for migration safety system
 */
export const COMPLETE_MIGRATION_SAFETY_SCHEMA = `
-- This includes all schemas from the safety system
-- Import and execute in order:

-- 1. Audit tables
${require('./audit').MIGRATION_AUDIT_SCHEMA}

-- 2. Approval tables  
${require('./accessControl').MIGRATION_APPROVAL_SCHEMA}

-- 3. Rollback tables
${require('./rollback').MIGRATION_ROLLBACK_SCHEMA}

-- 4. Additional security tables
CREATE TABLE IF NOT EXISTS migration_security_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id UUID,
  violation_type VARCHAR(100) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description TEXT NOT NULL,
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP WITH TIME ZONE,
  security_context JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_violations_migration_id ON migration_security_violations(migration_id);
CREATE INDEX IF NOT EXISTS idx_security_violations_severity ON migration_security_violations(severity);
CREATE INDEX IF NOT EXISTS idx_security_violations_detected_at ON migration_security_violations(detected_at);
`;
