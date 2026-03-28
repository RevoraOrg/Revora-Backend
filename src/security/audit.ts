/**
 * Security audit repository with comprehensive logging capabilities
 * 
 * Provides persistent storage and retrieval of security events
 * with efficient querying for compliance and monitoring.
 */

import { AuditEvent, SecurityAuditRepository } from './types';

/**
 * In-memory implementation for development and testing
 * In production, replace with database-backed implementation
 */
export class InMemorySecurityAuditRepository implements SecurityAuditRepository {
  private events: AuditEvent[] = [];
  private maxEvents = 10000; // Prevent memory leaks

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    
    // Prevent memory leaks by limiting stored events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents * 0.8); // Keep 80% of max
    }
  }

  async findByUserId(userId: string, limit = 100): Promise<AuditEvent[]> {
    return this.events
      .filter(event => event.userId === userId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async findBySessionId(sessionId: string, limit = 100): Promise<AuditEvent[]> {
    return this.events
      .filter(event => event.sessionId === sessionId)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  async findSecurityViolations(since: Date, limit = 100): Promise<AuditEvent[]> {
    return this.events
      .filter(event => 
        event.type === 'SECURITY_VIOLATION' && 
        event.timestamp >= since
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  // Helper methods for testing and monitoring
  clear(): void {
    this.events = [];
  }

  getAllEvents(): AuditEvent[] {
    return [...this.events];
  }

  getEventCount(): number {
    return this.events.length;
  }
}

/**
 * Production-ready database implementation
 * This would be implemented with your actual database (PostgreSQL, etc.)
 */
export class DatabaseSecurityAuditRepository implements SecurityAuditRepository {
  constructor(private pool: any) {} // PostgreSQL pool or similar

  async record(event: AuditEvent): Promise<void> {
    const query = `
      INSERT INTO security_audit_events (
        id, type, user_id, session_id, action, resource, outcome, 
        details, security_context, timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    await this.pool.query(query, [
      event.id,
      event.type,
      event.userId,
      event.sessionId,
      event.action,
      event.resource,
      event.outcome,
      JSON.stringify(event.details),
      JSON.stringify(event.securityContext),
      event.timestamp,
    ]);
  }

  async findByUserId(userId: string, limit = 100): Promise<AuditEvent[]> {
    const query = `
      SELECT * FROM security_audit_events 
      WHERE user_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [userId, limit]);
    return this.mapRowsToEvents(result.rows);
  }

  async findBySessionId(sessionId: string, limit = 100): Promise<AuditEvent[]> {
    const query = `
      SELECT * FROM security_audit_events 
      WHERE session_id = $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [sessionId, limit]);
    return this.mapRowsToEvents(result.rows);
  }

  async findSecurityViolations(since: Date, limit = 100): Promise<AuditEvent[]> {
    const query = `
      SELECT * FROM security_audit_events 
      WHERE type = 'SECURITY_VIOLATION' AND timestamp >= $1 
      ORDER BY timestamp DESC 
      LIMIT $2
    `;
    
    const result = await this.pool.query(query, [since, limit]);
    return this.mapRowsToEvents(result.rows);
  }

  private mapRowsToEvents(rows: any[]): AuditEvent[] {
    return rows.map(row => ({
      id: row.id,
      type: row.type,
      userId: row.user_id,
      sessionId: row.session_id,
      action: row.action,
      resource: row.resource,
      outcome: row.outcome,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
      securityContext: typeof row.security_context === 'string' 
        ? JSON.parse(row.security_context) 
        : row.security_context,
      timestamp: new Date(row.timestamp),
    }));
  }
}

/**
 * SQL schema for security audit events table
 * This should be added to your database migrations
 */
export const SECURITY_AUDIT_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS security_audit_events (
  id VARCHAR(255) PRIMARY KEY,
  type VARCHAR(50) NOT NULL CHECK (type IN ('AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'SECURITY_VIOLATION')),
  user_id VARCHAR(255),
  session_id VARCHAR(255),
  action VARCHAR(255) NOT NULL,
  resource VARCHAR(255) NOT NULL,
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'BLOCKED')),
  details JSONB,
  security_context JSONB NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  
  -- Indexes for efficient querying
  INDEX idx_audit_user_id (user_id),
  INDEX idx_audit_session_id (session_id),
  INDEX idx_audit_type (type),
  INDEX idx_audit_outcome (outcome),
  INDEX idx_audit_timestamp (timestamp),
  INDEX idx_audit_security_violations (type, timestamp) WHERE type = 'SECURITY_VIOLATION'
);

-- Partitioning for large-scale deployments (optional)
-- This table can be partitioned by timestamp for better performance
-- Example: PARTITION BY RANGE (timestamp)
`;

/**
 * Factory function to create appropriate repository based on environment
 */
export const createSecurityAuditRepository = (
  pool?: any,
  environment = process.env.NODE_ENV
): SecurityAuditRepository => {
  if (environment === 'production' && pool) {
    return new DatabaseSecurityAuditRepository(pool);
  }
  
  return new InMemorySecurityAuditRepository();
};
