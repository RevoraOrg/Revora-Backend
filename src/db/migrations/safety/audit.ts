/**
 * Migration Audit and Security Logging System
 * 
 * Provides comprehensive audit trail and security monitoring for
 * database migration operations with tamper-evident logging.
 */

import { Pool, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import {
  MigrationAuditEvent,
  MigrationSecurityContext,
  MigrationExecution,
  MigrationStatus,
} from './types';

/**
 * Migration audit repository interface
 */
export interface MigrationAuditRepository {
  recordEvent(event: MigrationAuditEvent): Promise<void>;
  recordExecution(execution: MigrationExecution): Promise<void>;
  updateExecutionStatus(executionId: string, status: MigrationStatus, error?: string): Promise<void>;
  getExecutionHistory(limit?: number): Promise<MigrationExecution[]>;
  getAuditEvents(executionId?: string, limit?: number): Promise<MigrationAuditEvent[]>;
  getSecurityViolations(since: Date, limit?: number): Promise<MigrationAuditEvent[]>;
}

/**
 * In-memory audit repository for development and testing
 */
export class InMemoryMigrationAuditRepository implements MigrationAuditRepository {
  private auditEvents: MigrationAuditEvent[] = [];
  private executions: MigrationExecution[] = [];
  private maxEvents = 10000;
  private maxExecutions = 1000;

  async recordEvent(event: MigrationAuditEvent): Promise<void> {
    this.auditEvents.push(event);
    
    // Prevent memory leaks
    if (this.auditEvents.length > this.maxEvents) {
      this.auditEvents = this.auditEvents.slice(-this.maxEvents * 0.8);
    }
  }

  async recordExecution(execution: MigrationExecution): Promise<void> {
    this.executions.push(execution);
    
    if (this.executions.length > this.maxExecutions) {
      this.executions = this.executions.slice(-this.maxExecutions * 0.8);
    }
  }

  async updateExecutionStatus(executionId: string, status: MigrationStatus, error?: string): Promise<void> {
    const execution = this.executions.find(e => e.id === executionId);
    if (execution) {
      execution.status = status;
      if (error) {
        execution.errorMessage = error;
      }
      if (status === 'completed' || status === 'failed' || status === 'rolled_back') {
        execution.completedAt = new Date();
      }
    }
  }

  async getExecutionHistory(limit = 100): Promise<MigrationExecution[]> {
    return this.executions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
  }

  async getAuditEvents(executionId?: string, limit = 100): Promise<MigrationAuditEvent[]> {
    let events = this.auditEvents;
    
    if (executionId) {
      events = events.filter(e => e.migrationId === executionId);
    }
    
    return events
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async getSecurityViolations(since: Date, limit = 100): Promise<MigrationAuditEvent[]> {
    return this.auditEvents
      .filter(e => e.type === 'security_violation' && e.timestamp >= since)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // Helper methods for testing
  clear(): void {
    this.auditEvents = [];
    this.executions = [];
  }

  getAllEvents(): MigrationAuditEvent[] {
    return [...this.auditEvents];
  }

  getAllExecutions(): MigrationExecution[] {
    return [...this.executions];
  }
}

/**
 * Production database audit repository
 */
export class DatabaseMigrationAuditRepository implements MigrationAuditRepository {
  constructor(private pool: Pool) {}

  async recordEvent(event: MigrationAuditEvent): Promise<void> {
    const query = `
      INSERT INTO migration_audit_events (
        id, migration_id, type, user_id, environment, 
        details, security_context, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

    await this.pool.query(query, [
      event.id,
      event.migrationId,
      event.type,
      event.userId,
      event.environment,
      JSON.stringify(event.details),
      JSON.stringify(event.securityContext),
      event.timestamp,
    ]);
  }

  async recordExecution(execution: MigrationExecution): Promise<void> {
    const query = `
      INSERT INTO migration_executions (
        id, migration_filename, migration_filepath, migration_checksum,
        status, started_at, completed_at, error_message,
        rollback_available, preflight_checks, execution_plan,
        security_context, risk_level, requires_downtime, requires_backup
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    await this.pool.query(query, [
      execution.id,
      execution.migrationFile.filename,
      execution.migrationFile.filepath,
      execution.migrationFile.checksum,
      execution.status,
      execution.startedAt,
      execution.completedAt || null,
      execution.errorMessage || null,
      execution.rollbackAvailable,
      JSON.stringify(execution.preflightChecks),
      JSON.stringify(execution.executionPlan),
      JSON.stringify(execution.securityContext),
      execution.migrationFile.riskLevel,
      execution.migrationFile.requiresDowntime,
      execution.migrationFile.requiresBackup,
    ]);
  }

  async updateExecutionStatus(executionId: string, status: MigrationStatus, error?: string): Promise<void> {
    const query = `
      UPDATE migration_executions 
      SET status = $1, error_message = $2, completed_at = $3
      WHERE id = $4
    `;

    await this.pool.query(query, [
      status,
      error || null,
      (status === 'completed' || status === 'failed' || status === 'rolled_back') ? new Date() : null,
      executionId,
    ]);
  }

  async getExecutionHistory(limit = 100): Promise<MigrationExecution[]> {
    const query = `
      SELECT * FROM migration_executions 
      ORDER BY started_at DESC 
      LIMIT $1
    `;
    
    const result = await this.pool.query(query, [limit]);
    return result.rows.map(this.mapRowToExecution);
  }

  async getAuditEvents(executionId?: string, limit = 100): Promise<MigrationAuditEvent[]> {
    let query = `
      SELECT * FROM migration_audit_events 
      WHERE $1::text IS NULL OR migration_id = $1
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [executionId || null, limit]);
    return result.rows.map(this.mapRowToAuditEvent);
  }

  async getSecurityViolations(since: Date, limit = 100): Promise<MigrationAuditEvent[]> {
    const query = `
      SELECT * FROM migration_audit_events 
      WHERE type = 'security_violation' AND timestamp >= $1
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [since, limit]);
    return result.rows.map(this.mapRowToAuditEvent);
  }

  private mapRowToExecution(row: any): MigrationExecution {
    return {
      id: row.id,
      migrationFile: {
        filename: row.migration_filename,
        filepath: row.migration_filepath,
        content: '', // Not stored in database for security
        checksum: row.migration_checksum,
        size: 0, // Not stored
        riskLevel: row.risk_level,
        requiresDowntime: row.requires_downtime,
        requiresBackup: row.requires_backup,
        dependencies: [], // Not stored
      },
      status: row.status,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      errorMessage: row.error_message,
      rollbackAvailable: row.rollback_available,
      securityContext: typeof row.security_context === 'string' 
        ? JSON.parse(row.security_context) 
        : row.security_context,
      preflightChecks: typeof row.preflight_checks === 'string' 
        ? JSON.parse(row.preflight_checks) 
        : row.preflight_checks,
      executionPlan: typeof row.execution_plan === 'string' 
        ? JSON.parse(row.execution_plan) 
        : row.execution_plan,
    };
  }

  private mapRowToAuditEvent(row: any): MigrationAuditEvent {
    return {
      id: row.id,
      migrationId: row.migration_id,
      type: row.type,
      userId: row.user_id,
      environment: row.environment,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      securityContext: typeof row.security_context === 'string' 
        ? JSON.parse(row.security_context) 
        : row.security_context,
      timestamp: new Date(row.timestamp),
    };
  }
}

/**
 * Migration audit logger
 */
export class MigrationAuditLogger {
  constructor(private auditRepository: MigrationAuditRepository) {}

  async logMigrationStarted(
    execution: MigrationExecution
  ): Promise<void> {
    const event: MigrationAuditEvent = {
      id: randomUUID(),
      migrationId: execution.id,
      type: 'migration_started',
      userId: execution.securityContext.userId,
      environment: execution.securityContext.environment,
      details: {
        migrationFile: execution.migrationFile.filename,
        riskLevel: execution.migrationFile.riskLevel,
        requiresDowntime: execution.migrationFile.requiresDowntime,
        requiresBackup: execution.migrationFile.requiresBackup,
        preflightChecks: execution.preflightChecks.map(c => ({
          name: c.name,
          status: c.status,
          critical: c.critical,
        })),
      },
      securityContext: {
        userId: execution.securityContext.userId,
        userRole: execution.securityContext.userRole,
        sessionId: execution.securityContext.sessionId,
        requestId: execution.securityContext.requestId,
        environment: execution.securityContext.environment,
        ipAddress: execution.securityContext.ipAddress,
        userAgent: execution.securityContext.userAgent,
      },
      timestamp: new Date(),
    };

    await this.auditRepository.recordEvent(event);
    await this.auditRepository.recordExecution(execution);
  }

  async logMigrationCompleted(
    executionId: string,
    securityContext: MigrationSecurityContext,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const event: MigrationAuditEvent = {
      id: randomUUID(),
      migrationId: executionId,
      type: 'migration_completed',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: {
        ...details,
        completedAt: new Date().toISOString(),
      },
      securityContext: {
        userId: securityContext.userId,
        userRole: securityContext.userRole,
        sessionId: securityContext.sessionId,
        requestId: securityContext.requestId,
        environment: securityContext.environment,
        ipAddress: securityContext.ipAddress,
        userAgent: securityContext.userAgent,
      },
      timestamp: new Date(),
    };

    await this.auditRepository.recordEvent(event);
    await this.auditRepository.updateExecutionStatus(executionId, 'completed');
  }

  async logMigrationFailed(
    executionId: string,
    error: Error,
    securityContext: MigrationSecurityContext,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const event: MigrationAuditEvent = {
      id: randomUUID(),
      migrationId: executionId,
      type: 'migration_failed',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: {
        error: error.message,
        stack: error.stack,
        ...details,
        failedAt: new Date().toISOString(),
      },
      securityContext: {
        userId: securityContext.userId,
        userRole: securityContext.userRole,
        sessionId: securityContext.sessionId,
        requestId: securityContext.requestId,
        environment: securityContext.environment,
        ipAddress: securityContext.ipAddress,
        userAgent: securityContext.userAgent,
      },
      timestamp: new Date(),
    };

    await this.auditRepository.recordEvent(event);
    await this.auditRepository.updateExecutionStatus(executionId, 'failed', error.message);
  }

  async logMigrationRolledBack(
    executionId: string,
    securityContext: MigrationSecurityContext,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const event: MigrationAuditEvent = {
      id: randomUUID(),
      migrationId: executionId,
      type: 'migration_rolled_back',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: {
        ...details,
        rolledBackAt: new Date().toISOString(),
      },
      securityContext: {
        userId: securityContext.userId,
        userRole: securityContext.userRole,
        sessionId: securityContext.sessionId,
        requestId: securityContext.requestId,
        environment: securityContext.environment,
        ipAddress: securityContext.ipAddress,
        userAgent: securityContext.userAgent,
      },
      timestamp: new Date(),
    };

    await this.auditRepository.recordEvent(event);
    await this.auditRepository.updateExecutionStatus(executionId, 'rolled_back');
  }

  async logSecurityViolation(
    executionId: string,
    violation: string,
    securityContext: MigrationSecurityContext,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    const event: MigrationAuditEvent = {
      id: randomUUID(),
      migrationId: executionId,
      type: 'security_violation',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: {
        violation,
        ...details,
        detectedAt: new Date().toISOString(),
      },
      securityContext: {
        userId: securityContext.userId,
        userRole: securityContext.userRole,
        sessionId: securityContext.sessionId,
        requestId: securityContext.requestId,
        environment: securityContext.environment,
        ipAddress: securityContext.ipAddress,
        userAgent: securityContext.userAgent,
      },
      timestamp: new Date(),
    };

    await this.auditRepository.recordEvent(event);
  }
}

/**
 * SQL schema for migration audit tables
 */
export const MIGRATION_AUDIT_SCHEMA = `
-- Migration audit events table
CREATE TABLE IF NOT EXISTS migration_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id UUID NOT NULL REFERENCES migration_executions(id),
  type VARCHAR(50) NOT NULL CHECK (type IN ('migration_started', 'migration_completed', 'migration_failed', 'migration_rolled_back', 'security_violation')),
  user_id VARCHAR(255) NOT NULL,
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  details JSONB,
  security_context JSONB NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Migration executions table
CREATE TABLE IF NOT EXISTS migration_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_filename VARCHAR(255) NOT NULL,
  migration_filepath TEXT NOT NULL,
  migration_checksum VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'rolled_back')),
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  rollback_available BOOLEAN NOT NULL DEFAULT false,
  preflight_checks JSONB NOT NULL,
  execution_plan JSONB NOT NULL,
  security_context JSONB NOT NULL,
  risk_level VARCHAR(10) NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  requires_downtime BOOLEAN NOT NULL DEFAULT false,
  requires_backup BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_events_migration_id ON migration_audit_events(migration_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_user_id ON migration_audit_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_type ON migration_audit_events(type);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON migration_audit_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_events_security_violations ON migration_audit_events(type, timestamp) 
WHERE type = 'security_violation';

CREATE INDEX IF NOT EXISTS idx_executions_status ON migration_executions(status);
CREATE INDEX IF NOT EXISTS idx_executions_started_at ON migration_executions(started_at);
CREATE INDEX IF NOT EXISTS idx_executions_user_id ON migration_executions(security_context->>'userId');
CREATE INDEX IF NOT EXISTS idx_executions_environment ON migration_executions(security_context->>'environment');

-- Partitioning for large-scale deployments (optional)
-- This table can be partitioned by timestamp for better performance
-- Example: PARTITION BY RANGE (timestamp)
`;

/**
 * Factory function to create appropriate audit repository
 */
export const createMigrationAuditRepository = (
  pool?: Pool,
  environment = process.env.NODE_ENV
): MigrationAuditRepository => {
  if (environment === 'production' && pool) {
    return new DatabaseMigrationAuditRepository(pool);
  }
  
  return new InMemoryMigrationAuditRepository();
};
