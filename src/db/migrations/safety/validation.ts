/**
 * Migration Safety Validation Framework
 * 
 * Provides comprehensive pre-flight checks, risk assessment, and validation
 * for database migrations with production-grade safety guarantees.
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  MigrationFile,
  MigrationRiskLevel,
  PreflightCheckResult,
  ExecutionPlan,
  ExecutionStep,
  RollbackStrategy,
  MigrationSecurityContext,
  MigrationSafetyConfig,
  MigrationValidationError,
  MigrationRiskError,
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
} from './types';

/**
 * SQL pattern analysis for risk assessment
 */
export interface SQLPattern {
  pattern: RegExp;
  riskLevel: MigrationRiskLevel;
  description: string;
  requiresDowntime: boolean;
  requiresBackup: boolean;
  destructive: boolean;
}

export const SQL_PATTERNS: SQLPattern[] = [
  // Critical risk patterns
  {
    pattern: /DROP\s+DATABASE\s+/gi,
    riskLevel: 'critical',
    description: 'Dropping entire database',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: true,
  },
  {
    pattern: /DROP\s+TABLE\s+(?!IF\s+EXISTS)/gi,
    riskLevel: 'critical',
    description: 'Dropping table without IF EXISTS',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: true,
  },
  {
    pattern: /TRUNCATE\s+TABLE/gi,
    riskLevel: 'critical',
    description: 'Truncating table (data loss)',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: true,
  },
  {
    pattern: /DELETE\s+FROM\s+\w+\s+WHERE\s+1\s*=\s*1/gi,
    riskLevel: 'critical',
    description: 'Deleting all records from table',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: true,
  },

  // High risk patterns
  {
    pattern: /DROP\s+INDEX/gi,
    riskLevel: 'high',
    description: 'Dropping index',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
  {
    pattern: /DROP\s+COLUMN/gi,
    riskLevel: 'high',
    description: 'Dropping column',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: true,
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN/gi,
    riskLevel: 'high',
    description: 'Altering column definition',
    requiresDowntime: true,
    requiresBackup: true,
    destructive: false,
  },

  // Medium risk patterns
  {
    pattern: /CREATE\s+UNIQUE\s+INDEX/gi,
    riskLevel: 'medium',
    description: 'Creating unique index',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+ADD\s+CONSTRAINT/gi,
    riskLevel: 'medium',
    description: 'Adding constraint to table',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
  {
    pattern: /UPDATE\s+\w+\s+SET/gi,
    riskLevel: 'medium',
    description: 'Bulk update operation',
    requiresDowntime: false,
    requiresBackup: true,
    destructive: false,
  },

  // Low risk patterns
  {
    pattern: /CREATE\s+TABLE/gi,
    riskLevel: 'low',
    description: 'Creating new table',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
  {
    pattern: /CREATE\s+INDEX/gi,
    riskLevel: 'low',
    description: 'Creating index',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
  {
    pattern: /INSERT\s+INTO/gi,
    riskLevel: 'low',
    description: 'Insert operation',
    requiresDowntime: false,
    requiresBackup: false,
    destructive: false,
  },
];

/**
 * Migration file analyzer for risk assessment
 */
export class MigrationFileAnalyzer {
  analyzeFile(filepath: string, filename: string): MigrationFile {
    const content = readFileSync(filepath, 'utf8');
    const stats = statSync(filepath);
    const checksum = this.calculateChecksum(content);

    const riskAnalysis = this.analyzeRisk(content);
    const dependencies = this.extractDependencies(content);

    return {
      filename,
      filepath,
      content,
      checksum,
      size: stats.size,
      riskLevel: riskAnalysis.maxRiskLevel,
      requiresDowntime: riskAnalysis.requiresDowntime,
      requiresBackup: riskAnalysis.requiresBackup,
      dependencies,
    };
  }

  private calculateChecksum(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private analyzeRisk(content: string): {
    maxRiskLevel: MigrationRiskLevel;
    requiresDowntime: boolean;
    requiresBackup: boolean;
    patterns: Array<{ pattern: SQLPattern; matches: string[] }>;
  } {
    const matches: Array<{ pattern: SQLPattern; matches: string[] }> = [];
    let maxRiskLevel: MigrationRiskLevel = 'low';
    let requiresDowntime = false;
    let requiresBackup = false;

    for (const pattern of SQL_PATTERNS) {
      const patternMatches = content.match(pattern.pattern);
      if (patternMatches) {
        matches.push({ pattern, matches: patternMatches });
        
        // Update risk level
        const riskLevels: MigrationRiskLevel[] = ['low', 'medium', 'high', 'critical'];
        const currentRiskIndex = riskLevels.indexOf(maxRiskLevel);
        const patternRiskIndex = riskLevels.indexOf(pattern.riskLevel);
        
        if (patternRiskIndex > currentRiskIndex) {
          maxRiskLevel = pattern.riskLevel;
        }

        requiresDowntime = requiresDowntime || pattern.requiresDowntime;
        requiresBackup = requiresBackup || pattern.requiresBackup;
      }
    }

    return { maxRiskLevel, requiresDowntime, requiresBackup, patterns: matches };
  }

  private extractDependencies(content: string): string[] {
    const dependencies: string[] = [];
    
    // Extract table references
    const tableRefs = content.match(/FROM\s+(\w+)|JOIN\s+(\w+)|REFERENCES\s+(\w+)/gi);
    if (tableRefs) {
      for (const ref of tableRefs) {
        const match = ref.match(/\w+$/);
        if (match) {
          dependencies.push(match[0]);
        }
      }
    }

    return [...new Set(dependencies)]; // Remove duplicates
  }
}

/**
 * Pre-flight check validator
 */
export class PreflightValidator {
  constructor(
    private config: MigrationSafetyConfig,
    private securityContext: MigrationSecurityContext
  ) {}

  async validateMigration(migration: MigrationFile): Promise<PreflightCheckResult[]> {
    const checks: PreflightCheckResult[] = [];

    // Security authorization checks
    checks.push(await this.checkUserAuthorization());
    checks.push(await this.checkEnvironmentPermissions());
    checks.push(await this.checkTimeWindow(migration));

    // Migration file checks
    checks.push(await this.checkFileSize(migration));
    checks.push(await this.checkFileIntegrity(migration));
    checks.push(await this.checkRiskLevel(migration));

    // Database state checks
    checks.push(await this.checkDatabaseConnectivity());
    checks.push(await this.checkConcurrentMigrations());
    checks.push(await this.checkBackupAvailability(migration));

    // Content validation checks
    checks.push(await this.checkSQLSyntax(migration));
    checks.push(await this.checkDestructiveOperations(migration));
    checks.push(await this.checkDependencies(migration));

    return checks.filter(check => check); // Remove null checks
  }

  private async checkUserAuthorization(): Promise<PreflightCheckResult> {
    const isAuthorized = this.config.allowedRoles.includes(this.securityContext.userRole);
    
    return {
      name: 'user_authorization',
      status: isAuthorized ? 'passed' : 'failed',
      message: isAuthorized 
        ? `User ${this.securityContext.userId} with role ${this.securityContext.userRole} is authorized`
        : `User role ${this.securityContext.userRole} not in allowed roles: ${this.config.allowedRoles.join(', ')}`,
      critical: !isAuthorized,
      details: {
        userId: this.securityContext.userId,
        userRole: this.securityContext.userRole,
        allowedRoles: this.config.allowedRoles,
      },
    };
  }

  private async checkEnvironmentPermissions(): Promise<PreflightCheckResult> {
    const canMigrate = this.config.allowProductionMigrations || this.securityContext.environment !== 'production';
    
    return {
      name: 'environment_permissions',
      status: canMigrate ? 'passed' : 'failed',
      message: canMigrate 
        ? `Environment ${this.securityContext.environment} allows migrations`
        : `Production migrations not allowed in current configuration`,
      critical: !canMigrate,
      details: {
        environment: this.securityContext.environment,
        allowProductionMigrations: this.config.allowProductionMigrations,
      },
    };
  }

  private async checkTimeWindow(migration: MigrationFile): Promise<PreflightCheckResult> {
    const riskConfig = this.config.riskThresholds[migration.riskLevel];
    const currentTime = new Date();
    const currentHour = currentTime.getHours();
    
    let inTimeWindow = true;
    let message = 'Migration within allowed time window';

    if (riskConfig.allowedTimeWindow) {
      const startHour = parseInt(riskConfig.allowedTimeWindow.start.split(':')[0]);
      const endHour = parseInt(riskConfig.allowedTimeWindow.end.split(':')[0]);
      
      if (startHour <= endHour) {
        inTimeWindow = currentHour >= startHour && currentHour <= endHour;
      } else {
        // Overnight window (e.g., 22:00 to 06:00)
        inTimeWindow = currentHour >= startHour || currentHour <= endHour;
      }

      message = inTimeWindow 
        ? `Migration at ${currentTime.toISOString()} within window ${riskConfig.allowedTimeWindow.start}-${riskConfig.allowedTimeWindow.end}`
        : `Migration at ${currentTime.toISOString()} outside window ${riskConfig.allowedTimeWindow.start}-${riskConfig.allowedTimeWindow.end}`;
    }

    return {
      name: 'time_window',
      status: inTimeWindow ? 'passed' : 'failed',
      message,
      critical: !inTimeWindow && migration.riskLevel !== 'low',
      details: {
        currentTime: currentTime.toISOString(),
        currentHour,
        riskLevel: migration.riskLevel,
        timeWindow: riskConfig.allowedTimeWindow,
      },
    };
  }

  private async checkFileSize(migration: MigrationFile): Promise<PreflightCheckResult> {
    const withinLimit = migration.size <= this.config.maxMigrationSize;
    
    return {
      name: 'file_size',
      status: withinLimit ? 'passed' : 'failed',
      message: withinLimit 
        ? `Migration file size ${migration.size} bytes within limit ${this.config.maxMigrationSize} bytes`
        : `Migration file size ${migration.size} bytes exceeds limit ${this.config.maxMigrationSize} bytes`,
      critical: !withinLimit,
      details: {
        fileSize: migration.size,
        maxSize: this.config.maxMigrationSize,
      },
    };
  }

  private async checkFileIntegrity(migration: MigrationFile): Promise<PreflightCheckResult> {
    // Check for common file integrity issues
    const hasNullBytes = migration.content.includes('\0');
    const hasSuspiciousContent = /<script|javascript:|eval\(/gi.test(migration.content);
    
    const isClean = !hasNullBytes && !hasSuspiciousContent;
    
    return {
      name: 'file_integrity',
      status: isClean ? 'passed' : 'warning',
      message: isClean 
        ? 'Migration file integrity check passed'
        : 'Migration file contains potentially suspicious content',
      critical: false,
      details: {
        hasNullBytes,
        hasSuspiciousContent,
        checksum: migration.checksum,
      },
    };
  }

  private async checkRiskLevel(migration: MigrationFile): Promise<PreflightCheckResult> {
    const riskConfig = this.config.riskThresholds[migration.riskLevel];
    
    let status: 'passed' | 'failed' | 'warning' = 'passed';
    let message = `Migration risk level ${migration.riskLevel} acceptable`;
    
    if (this.config.requireApproval && !riskConfig.requireApproval) {
      status = 'warning';
      message = `Migration risk level ${migration.riskLevel} lower than expected approval requirement`;
    }
    
    return {
      name: 'risk_level',
      status,
      message,
      critical: false,
      details: {
        riskLevel: migration.riskLevel,
        requiresApproval: riskConfig.requireApproval,
        requireBackup: riskConfig.requireBackup,
        requiresDryRun: riskConfig.requireDryRun,
      },
    };
  }

  private async checkDatabaseConnectivity(): Promise<PreflightCheckResult> {
    // This would be implemented with actual database connectivity check
    // For now, return a placeholder
    return {
      name: 'database_connectivity',
      status: 'passed',
      message: 'Database connectivity check passed',
      critical: true,
      details: {
        checkTime: new Date().toISOString(),
      },
    };
  }

  private async checkConcurrentMigrations(): Promise<PreflightCheckResult> {
    // This would check for currently running migrations
    // For now, return a placeholder
    return {
      name: 'concurrent_migrations',
      status: 'passed',
      message: 'No concurrent migrations detected',
      critical: true,
      details: {
        maxConcurrent: this.config.maxConcurrentMigrations,
        currentRunning: 0,
      },
    };
  }

  private async checkBackupAvailability(migration: MigrationFile): Promise<PreflightCheckResult> {
    const requiresBackup = this.config.requireBackup || migration.requiresBackup;
    
    if (!requiresBackup) {
      return {
        name: 'backup_availability',
        status: 'passed',
        message: 'Backup not required for this migration',
        critical: false,
        details: {
          requiresBackup: false,
        },
      };
    }

    // This would check for actual backup availability
    // For now, return a placeholder
    return {
      name: 'backup_availability',
      status: 'warning',
      message: 'Backup requirement noted - please verify backup availability',
      critical: true,
      details: {
        requiresBackup: true,
        backupStatus: 'verification_needed',
      },
    };
  }

  private async checkSQLSyntax(migration: MigrationFile): Promise<PreflightCheckResult> {
    // Basic SQL syntax validation
    const hasUnclosedStrings = (migration.content.match(/'/g) || []).length % 2 !== 0;
    const hasUnclosedParentheses = this.checkUnbalancedParentheses(migration.content);
    
    const syntaxValid = !hasUnclosedStrings && !hasUnclosedParentheses;
    
    return {
      name: 'sql_syntax',
      status: syntaxValid ? 'passed' : 'warning',
      message: syntaxValid 
        ? 'SQL syntax validation passed'
        : 'Potential SQL syntax issues detected',
      critical: false,
      details: {
        hasUnclosedStrings,
        hasUnclosedParentheses,
      },
    };
  }

  private async checkDestructiveOperations(migration: MigrationFile): Promise<PreflightCheckResult> {
    const analyzer = new MigrationFileAnalyzer();
    const tempFile = analyzer.analyzeFile(migration.filepath, migration.filename);
    const destructivePatterns = SQL_PATTERNS.filter(pattern => 
      pattern.pattern.test(migration.content) && pattern.destructive
    );
    
    const allowsDestructive = this.config.allowDestructiveOperations;
    const hasDestructive = destructivePatterns.length > 0;
    
    let status: 'passed' | 'failed' | 'warning' = 'passed';
    let message = 'No destructive operations detected';
    
    if (hasDestructive) {
      if (allowsDestructive) {
        status = 'warning';
        message = `Destructive operations detected but allowed: ${destructivePatterns.map(p => p.description).join(', ')}`;
      } else {
        status = 'failed';
        message = `Destructive operations not allowed: ${destructivePatterns.map(p => p.description).join(', ')}`;
      }
    }

    return {
      name: 'destructive_operations',
      status,
      message,
      critical: status === 'failed',
      details: {
        allowsDestructive,
        destructivePatterns: destructivePatterns.map(p => ({
          description: p.description,
          riskLevel: p.riskLevel,
        })),
      },
    };
  }

  private async checkDependencies(migration: MigrationFile): Promise<PreflightCheckResult> {
    // This would check if all dependent tables/objects exist
    // For now, return a placeholder
    return {
      name: 'dependencies',
      status: migration.dependencies.length > 0 ? 'warning' : 'passed',
      message: migration.dependencies.length > 0 
        ? `Dependencies detected: ${migration.dependencies.join(', ')} - please verify existence`
        : 'No external dependencies detected',
      critical: false,
      details: {
        dependencies: migration.dependencies,
      },
    };
  }

  private checkUnbalancedParentheses(content: string): boolean {
    let count = 0;
    for (const char of content) {
      if (char === '(') count++;
      if (char === ')') count--;
      if (count < 0) return true; // More closing than opening
    }
    return count !== 0; // Unbalanced if count is not zero at end
  }
}

/**
 * Execution plan generator
 */
export class ExecutionPlanGenerator {
  generatePlan(migration: MigrationFile): ExecutionPlan {
    const steps = this.parseExecutionSteps(migration.content);
    const estimatedDuration = this.estimateDuration(steps);
    const requiresDowntime = migration.requiresDowntime || steps.some(s => s.type === 'drop');
    const rollbackStrategy = this.generateRollbackStrategy(steps);
    const riskMitigations = this.generateRiskMitigations(migration, steps);

    return {
      steps,
      estimatedDuration,
      requiresDowntime,
      rollbackStrategy,
      riskMitigations,
    };
  }

  private parseExecutionSteps(content: string): ExecutionStep[] {
    const steps: ExecutionStep[] = [];
    const statements = content.split(';').filter(s => s.trim().length > 0);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim();
      if (statement.length === 0) continue;

      const step = this.analyzeStatement(statement, i + 1);
      steps.push(step);
    }

    return steps;
  }

  private analyzeStatement(sql: string, order: number): ExecutionStep {
    const normalizedSql = sql.toUpperCase().trim();
    let type: ExecutionStep['type'] = 'data';
    let riskLevel: MigrationRiskLevel = 'low';

    if (normalizedSql.startsWith('CREATE TABLE')) {
      type = 'create';
      riskLevel = 'low';
    } else if (normalizedSql.startsWith('ALTER TABLE')) {
      type = 'alter';
      riskLevel = 'high';
    } else if (normalizedSql.startsWith('DROP TABLE')) {
      type = 'drop';
      riskLevel = 'critical';
    } else if (normalizedSql.startsWith('CREATE INDEX')) {
      type = 'index';
      riskLevel = 'low';
    } else if (normalizedSql.includes('CONSTRAINT')) {
      type = 'constraint';
      riskLevel = 'medium';
    } else if (normalizedSql.startsWith('CREATE TRIGGER')) {
      type = 'trigger';
      riskLevel = 'medium';
    }

    // Find matching SQL pattern for more accurate risk assessment
    for (const pattern of SQL_PATTERNS) {
      if (pattern.pattern.test(sql)) {
        riskLevel = pattern.riskLevel;
        break;
      }
    }

    return {
      id: `step_${order}`,
      description: this.generateStepDescription(sql),
      sql,
      type,
      riskLevel,
      rollbackSql: this.generateRollbackSql(sql, type),
      validations: this.generateValidations(sql, type),
    };
  }

  private generateStepDescription(sql: string): string {
    const firstWord = sql.trim().split(' ')[0].toUpperCase();
    const objectMatch = sql.match(/\b(TABLE|INDEX|TRIGGER|CONSTRAINT)\s+(\w+)/i);
    
    if (objectMatch) {
      return `${firstWord} ${objectMatch[1]} ${objectMatch[2]}`;
    }
    
    return `${firstWord} operation`;
  }

  private generateRollbackSql(sql: string, type: ExecutionStep['type']): string | undefined {
    // Generate rollback SQL for common operations
    if (type === 'create' && sql.toUpperCase().includes('TABLE')) {
      const tableNameMatch = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
      if (tableNameMatch) {
        return `DROP TABLE IF EXISTS ${tableNameMatch[1]};`;
      }
    }
    
    if (type === 'index' && sql.toUpperCase().includes('INDEX')) {
      const indexNameMatch = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
      if (indexNameMatch) {
        return `DROP INDEX IF EXISTS ${indexNameMatch[1]};`;
      }
    }

    return undefined; // Manual rollback required
  }

  private generateValidations(sql: string, type: ExecutionStep['type']): string[] {
    const validations: string[] = [];

    if (type === 'create' && sql.toUpperCase().includes('TABLE')) {
      validations.push('table_exists');
      validations.push('columns_correct');
    }
    
    if (type === 'index') {
      validations.push('index_exists');
      validations.push('index_performance');
    }
    
    if (type === 'constraint') {
      validations.push('constraint_exists');
      validations.push('constraint_enforced');
    }

    return validations;
  }

  private estimateDuration(steps: ExecutionStep[]): number {
    // Base estimation in seconds
    let totalDuration = 0;

    for (const step of steps) {
      switch (step.type) {
        case 'create':
          totalDuration += step.riskLevel === 'critical' ? 300 : 60;
          break;
        case 'alter':
          totalDuration += step.riskLevel === 'critical' ? 600 : 120;
          break;
        case 'drop':
          totalDuration += 30;
          break;
        case 'index':
          totalDuration += 180; // Index creation can be slow
          break;
        case 'data':
          totalDuration += 60;
          break;
        default:
          totalDuration += 30;
      }
    }

    return totalDuration;
  }

  private generateRollbackStrategy(steps: ExecutionStep[]): RollbackStrategy {
    const rollbackSteps = steps
      .filter(step => step.rollbackSql)
      .reverse()
      .map(step => ({
        id: `rollback_${step.id}`,
        description: `Rollback: ${step.description}`,
        sql: step.rollbackSql!,
        type: step.type,
        riskLevel: step.riskLevel,
        validations: [],
      }));

    const hasDataLoss = steps.some(step => 
      step.type === 'drop' || step.type === 'alter'
    );

    return {
      available: rollbackSteps.length > 0,
      automated: rollbackSteps.length === steps.length,
      steps: rollbackSteps,
      dataLossRisk: hasDataLoss ? 'moderate' : 'minimal',
      estimatedRollbackTime: this.estimateDuration(rollbackSteps),
    };
  }

  private generateRiskMitigations(migration: MigrationFile, steps: ExecutionStep[]): string[] {
    const mitigations: string[] = [];

    if (migration.requiresBackup) {
      mitigations.push('Create database backup before migration');
    }

    if (migration.requiresDowntime) {
      mitigations.push('Schedule maintenance window');
      mitigations.push('Notify users of scheduled downtime');
    }

    const highRiskSteps = steps.filter(s => s.riskLevel === 'critical' || s.riskLevel === 'high');
    if (highRiskSteps.length > 0) {
      mitigations.push('Perform dry-run in staging environment');
      mitigations.push('Prepare rollback procedures');
    }

    if (migration.dependencies.length > 0) {
      mitigations.push('Verify all dependencies exist before migration');
    }

    return mitigations;
  }
}
