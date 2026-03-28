/**
 * Migration Access Control and Authorization System
 * 
 * Provides role-based access control, approval workflows, and
 * security enforcement for database migration operations.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import {
  MigrationSecurityContext,
  MigrationEnvironment,
  MigrationSafetyConfig,
  MigrationAuthorizationError,
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
} from './types';
import { MigrationAuditLogger } from './audit';

/**
 * User roles for migration operations
 */
export type MigrationRole = 'admin' | 'dba' | 'developer' | 'readonly';

/**
 * Approval status for migration operations
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/**
 * Migration approval request
 */
export interface MigrationApprovalRequest {
  id: string;
  migrationId: string;
  requesterId: string;
  requesterRole: MigrationRole;
  migrationFilename: string;
  migrationRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  environment: MigrationEnvironment;
  status: ApprovalStatus;
  requestedAt: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  reviewerRole?: MigrationRole;
  reviewComments?: string;
  expiresAt?: Date;
  securityContext: MigrationSecurityContext;
}

/**
 * Migration permission interface
 */
export interface MigrationPermission {
  canRead: boolean;
  canWrite: boolean;
  canExecute: boolean;
  canApprove: boolean;
  canRollback: boolean;
  maxRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  environments: MigrationEnvironment[];
  timeRestrictions?: {
    startHour: number;
    endHour: number;
    daysOfWeek: number[]; // 0 = Sunday, 6 = Saturday
  };
}

/**
 * Role-based permission matrix
 */
export const ROLE_PERMISSIONS: Record<MigrationRole, MigrationPermission> = {
  admin: {
    canRead: true,
    canWrite: true,
    canExecute: true,
    canApprove: true,
    canRollback: true,
    maxRiskLevel: 'critical',
    environments: ['development', 'staging', 'production'],
  },
  dba: {
    canRead: true,
    canWrite: true,
    canExecute: true,
    canApprove: true,
    canRollback: true,
    maxRiskLevel: 'high',
    environments: ['development', 'staging', 'production'],
  },
  developer: {
    canRead: true,
    canWrite: true,
    canExecute: true,
    canApprove: false,
    canRollback: false,
    maxRiskLevel: 'medium',
    environments: ['development', 'staging'],
  },
  readonly: {
    canRead: true,
    canWrite: false,
    canExecute: false,
    canApprove: false,
    canRollback: false,
    maxRiskLevel: 'low',
    environments: ['development', 'staging', 'production'],
  },
};

/**
 * Migration approval repository interface
 */
export interface MigrationApprovalRepository {
  createRequest(request: Omit<MigrationApprovalRequest, 'id' | 'requestedAt'>): Promise<MigrationApprovalRequest>;
  updateRequestStatus(requestId: string, status: ApprovalStatus, reviewedBy: string, reviewComments?: string): Promise<void>;
  getRequest(requestId: string): Promise<MigrationApprovalRequest | null>;
  getPendingRequests(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]>;
  getRequestsByUser(userId: string): Promise<MigrationApprovalRequest[]>;
  expireRequests(): Promise<number>;
  getPendingApprovals(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]>;
}

/**
 * In-memory approval repository for development
 */
export class InMemoryMigrationApprovalRepository implements MigrationApprovalRepository {
  private requests: Map<string, MigrationApprovalRequest> = new Map();

  async createRequest(request: Omit<MigrationApprovalRequest, 'id' | 'requestedAt'>): Promise<MigrationApprovalRequest> {
    const newRequest: MigrationApprovalRequest = {
      ...request,
      id: randomUUID(),
      requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    };

    this.requests.set(newRequest.id, newRequest);
    return newRequest;
  }

  async updateRequestStatus(requestId: string, status: ApprovalStatus, reviewedBy: string, reviewComments?: string): Promise<void> {
    const request = this.requests.get(requestId);
    if (request) {
      request.status = status;
      request.reviewedAt = new Date();
      request.reviewedBy = reviewedBy;
      request.reviewComments = reviewComments;
    }
  }

  async getRequest(requestId: string): Promise<MigrationApprovalRequest | null> {
    return this.requests.get(requestId) || null;
  }

  async getPendingRequests(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]> {
    return Array.from(this.requests.values())
      .filter(r => r.status === 'pending' && r.environment === environment)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  async getRequestsByUser(userId: string): Promise<MigrationApprovalRequest[]> {
    return Array.from(this.requests.values())
      .filter(r => r.requesterId === userId)
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  }

  async expireRequests(): Promise<number> {
    const now = new Date();
    let expiredCount = 0;

    for (const [id, request] of this.requests.entries()) {
      if (request.status === 'pending' && request.expiresAt && request.expiresAt < now) {
        request.status = 'expired';
        expiredCount++;
      }
    }

    return expiredCount;
  }

  async getPendingApprovals(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]> {
    return Array.from(this.requests.values())
      .filter(r => r.status === 'pending' && r.environment === environment)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  // Helper methods for testing
  clear(): void {
    this.requests.clear();
  }

  getAllRequests(): MigrationApprovalRequest[] {
    return Array.from(this.requests.values());
  }
}

/**
 * Database approval repository for production
 */
export class DatabaseMigrationApprovalRepository implements MigrationApprovalRepository {
  constructor(private pool: Pool) {}

  async createRequest(request: Omit<MigrationApprovalRequest, 'id' | 'requestedAt'>): Promise<MigrationApprovalRequest> {
    const query = `
      INSERT INTO migration_approval_requests (
        migration_id, requester_id, requester_role, migration_filename,
        migration_risk_level, environment, status, expires_at, security_context
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;

    const result = await this.pool.query(query, [
      request.migrationId,
      request.requesterId,
      request.requesterRole,
      request.migrationFilename,
      request.migrationRiskLevel,
      request.environment,
      request.status,
      request.expiresAt,
      JSON.stringify(request.securityContext),
    ]);

    return this.mapRowToRequest(result.rows[0]);
  }

  async updateRequestStatus(requestId: string, status: ApprovalStatus, reviewedBy: string, reviewComments?: string): Promise<void> {
    const query = `
      UPDATE migration_approval_requests 
      SET status = $1, reviewed_at = NOW(), reviewed_by = $2, review_comments = $3
      WHERE id = $4
    `;

    await this.pool.query(query, [status, reviewedBy, reviewComments, requestId]);
  }

  async getRequest(requestId: string): Promise<MigrationApprovalRequest | null> {
    const query = 'SELECT * FROM migration_approval_requests WHERE id = $1';
    const result = await this.pool.query(query, [requestId]);
    return result.rows.length > 0 ? this.mapRowToRequest(result.rows[0]) : null;
  }

  async getPendingRequests(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]> {
    const query = `
      SELECT * FROM migration_approval_requests 
      WHERE status = 'pending' AND environment = $1 
      ORDER BY requested_at ASC
    `;
    const result = await this.pool.query(query, [environment]);
    return result.rows.map(this.mapRowToRequest);
  }

  async getRequestsByUser(userId: string): Promise<MigrationApprovalRequest[]> {
    const query = `
      SELECT * FROM migration_approval_requests 
      WHERE requester_id = $1 
      ORDER BY requested_at DESC
    `;
    const result = await this.pool.query(query, [userId]);
    return result.rows.map(this.mapRowToRequest);
  }

  async expireRequests(): Promise<number> {
    const query = `
      UPDATE migration_approval_requests 
      SET status = 'expired' 
      WHERE status = 'pending' AND expires_at < NOW()
    `;
    const result = await this.pool.query(query);
    return result.rowCount || 0;
  }

  async getPendingApprovals(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]> {
    const query = `
      SELECT * FROM migration_approval_requests 
      WHERE status = 'pending' AND environment = $1 
      ORDER BY requested_at ASC
    `;
    const result = await this.pool.query(query, [environment]);
    return result.rows.map(this.mapRowToRequest);
  }

  private mapRowToRequest(row: any): MigrationApprovalRequest {
    return {
      id: row.id,
      migrationId: row.migration_id,
      requesterId: row.requester_id,
      requesterRole: row.requester_role,
      migrationFilename: row.migration_filename,
      migrationRiskLevel: row.migration_risk_level,
      environment: row.environment,
      status: row.status,
      requestedAt: new Date(row.requested_at),
      reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : undefined,
      reviewedBy: row.reviewed_by || undefined,
      reviewerRole: row.reviewer_role || undefined,
      reviewComments: row.review_comments || undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      securityContext: typeof row.security_context === 'string' 
        ? JSON.parse(row.security_context) 
        : row.security_context,
    };
  }
}

/**
 * Migration access control service
 */
export class MigrationAccessControl {
  constructor(
    private approvalRepository: MigrationApprovalRepository,
    private auditLogger: MigrationAuditLogger,
    private config: MigrationSafetyConfig
  ) {}

  /**
   * Check if user has permission to execute migration
   */
  async canExecuteMigration(
    securityContext: MigrationSecurityContext,
    migrationRiskLevel: 'low' | 'medium' | 'high' | 'critical'
  ): Promise<{ allowed: boolean; reason?: string; approvalRequired?: boolean }> {
    const userRole = securityContext.userRole as MigrationRole;
    const permissions = ROLE_PERMISSIONS[userRole];

    if (!permissions) {
      await this.auditLogger.logSecurityViolation(
        'unknown',
        `Unknown user role: ${userRole}`,
        securityContext,
        { userRole, migrationRiskLevel }
      );
      return { allowed: false, reason: `Unknown user role: ${userRole}` };
    }

    // Check basic execution permission
    if (!permissions.canExecute) {
      return { allowed: false, reason: 'Role does not have execution permission' };
    }

    // Check environment permission
    if (!permissions.environments.includes(securityContext.environment)) {
      return { allowed: false, reason: `Role not allowed in environment: ${securityContext.environment}` };
    }

    // Check risk level permission
    const riskLevels: ('low' | 'medium' | 'high' | 'critical')[] = ['low', 'medium', 'high', 'critical'];
    const userMaxRiskIndex = riskLevels.indexOf(permissions.maxRiskLevel);
    const migrationRiskIndex = riskLevels.indexOf(migrationRiskLevel);
    
    if (migrationRiskIndex > userMaxRiskIndex) {
      return { 
        allowed: false, 
        reason: `Risk level ${migrationRiskLevel} exceeds maximum allowed ${permissions.maxRiskLevel}` 
      };
    }

    // Check time restrictions
    if (permissions.timeRestrictions) {
      const currentTime = new Date();
      const currentHour = currentTime.getHours();
      const currentDay = currentTime.getDay();

      const inTimeWindow = currentHour >= permissions.timeRestrictions.startHour &&
                          currentHour <= permissions.timeRestrictions.endHour &&
                          permissions.timeRestrictions.daysOfWeek.includes(currentDay);

      if (!inTimeWindow) {
        return { 
          allowed: false, 
          reason: `Migration not allowed at this time. Hours: ${permissions.timeRestrictions.startHour}-${permissions.timeRestrictions.endHour}, Days: ${permissions.timeRestrictions.daysOfWeek.join(', ')}` 
        };
      }
    }

    // Check if approval is required
    const approvalRequired = this.config.requireApproval || 
                           this.config.riskThresholds[migrationRiskLevel].requireApproval;

    if (approvalRequired && !permissions.canApprove) {
      return { 
        allowed: false, 
        reason: 'Approval required but user cannot approve migrations',
        approvalRequired: true 
      };
    }

    return { allowed: true, approvalRequired };
  }

  /**
   * Create approval request for migration
   */
  async createApprovalRequest(
    migrationId: string,
    migrationFilename: string,
    migrationRiskLevel: 'low' | 'medium' | 'high' | 'critical',
    securityContext: MigrationSecurityContext
  ): Promise<MigrationApprovalRequest> {
    const userRole = securityContext.userRole as MigrationRole;
    
    const request = await this.approvalRepository.createRequest({
      migrationId,
      requesterId: securityContext.userId,
      requesterRole: userRole,
      migrationFilename,
      migrationRiskLevel,
      environment: securityContext.environment,
      status: 'pending',
      securityContext,
    });

    return request;
  }

  /**
   * Approve migration request
   */
  async approveMigrationRequest(
    requestId: string,
    approvedBy: string,
    approverRole: MigrationRole,
    reviewComments?: string
  ): Promise<void> {
    const request = await this.approvalRepository.getRequest(requestId);
    if (!request) {
      throw new MigrationAuthorizationError('Approval request not found', { requestId });
    }

    if (request.status !== 'pending') {
      throw new MigrationAuthorizationError('Request is not pending', { 
        requestId, 
        currentStatus: request.status 
      });
    }

    const approverPermissions = ROLE_PERMISSIONS[approverRole];
    if (!approverPermissions.canApprove) {
      throw new MigrationAuthorizationError('Approver does not have approval permission', { 
        approverRole,
        requestId 
      });
    }

    await this.approvalRepository.updateRequestStatus(requestId, 'approved', approvedBy, reviewComments);
  }

  /**
   * Reject migration request
   */
  async rejectMigrationRequest(
    requestId: string,
    rejectedBy: string,
    rejectorRole: MigrationRole,
    reviewComments?: string
  ): Promise<void> {
    const request = await this.approvalRepository.getRequest(requestId);
    if (!request) {
      throw new MigrationAuthorizationError('Approval request not found', { requestId });
    }

    if (request.status !== 'pending') {
      throw new MigrationAuthorizationError('Request is not pending', { 
        requestId, 
        currentStatus: request.status 
      });
    }

    const rejectorPermissions = ROLE_PERMISSIONS[rejectorRole];
    if (!rejectorPermissions.canApprove) {
      throw new MigrationAuthorizationError('Rejector does not have approval permission', { 
        rejectorRole,
        requestId 
      });
    }

    await this.approvalRepository.updateRequestStatus(requestId, 'rejected', rejectedBy, reviewComments);
  }

  /**
   * Check if migration has valid approval
   */
  async hasValidApproval(
    migrationId: string,
    securityContext: MigrationSecurityContext
  ): Promise<{ approved: boolean; approval?: MigrationApprovalRequest }> {
    // For users who can approve their own migrations (admin, dba)
    const userRole = securityContext.userRole as MigrationRole;
    const permissions = ROLE_PERMISSIONS[userRole];
    
    if (permissions.canApprove) {
      return { approved: true };
    }

    // Check for existing approval
    const pendingRequests = await this.approvalRepository.getPendingRequests(securityContext.environment);
    const approvedRequest = pendingRequests.find(r => r.migrationId === migrationId && r.status === 'approved');

    if (approvedRequest) {
      // Check if approval is still valid (not expired)
      if (approvedRequest.expiresAt && approvedRequest.expiresAt > new Date()) {
        return { approved: true, approval: approvedRequest };
      }
    }

    return { approved: false };
  }

  /**
   * Get pending approval requests
   */
  async getPendingRequests(environment: MigrationEnvironment): Promise<MigrationApprovalRequest[]> {
    return this.approvalRepository.getPendingRequests(environment);
  }

  /**
   * Get user's approval requests
   */
  async getUserRequests(userId: string): Promise<MigrationApprovalRequest[]> {
    return this.approvalRepository.getRequestsByUser(userId);
  }

  /**
   * Clean up expired requests
   */
  async cleanupExpiredRequests(): Promise<number> {
    return this.approvalRepository.expireRequests();
  }
}

/**
 * SQL schema for approval system
 */
export const MIGRATION_APPROVAL_SCHEMA = `
-- Migration approval requests table
CREATE TABLE IF NOT EXISTS migration_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_id UUID NOT NULL,
  requester_id VARCHAR(255) NOT NULL,
  requester_role VARCHAR(20) NOT NULL CHECK (requester_role IN ('admin', 'dba', 'developer', 'readonly')),
  migration_filename VARCHAR(255) NOT NULL,
  migration_risk_level VARCHAR(10) NOT NULL CHECK (migration_risk_level IN ('low', 'medium', 'high', 'critical')),
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMP WITH TIME ZONE,
  reviewed_by VARCHAR(255),
  reviewer_role VARCHAR(20),
  review_comments TEXT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  security_context JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_approval_requests_migration_id ON migration_approval_requests(migration_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_requester_id ON migration_approval_requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON migration_approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_environment ON migration_approval_requests(environment);
CREATE INDEX IF NOT EXISTS idx_approval_requests_expires_at ON migration_approval_requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_env ON migration_approval_requests(status, environment) 
WHERE status = 'pending';
`;

/**
 * Factory function to create appropriate approval repository
 */
export const createMigrationApprovalRepository = (
  pool?: Pool,
  environment = process.env.NODE_ENV
): MigrationApprovalRepository => {
  if (environment === 'production' && pool) {
    return new DatabaseMigrationApprovalRepository(pool);
  }
  
  return new InMemoryMigrationApprovalRepository();
};
