/**
 * Focused Unit and Integration Test Suite for Migration Access Control & Role Policies
 * 
 * Provides deterministic test coverage for MigrationRole, ApprovalStatus, MigrationApprovalRequest,
 * ROLE_PERMISSIONS, MigrationAccessControl state transitions, and repository implementations.
 */

import { Pool } from 'pg';
import {
  MigrationRole,
  ApprovalStatus,
  MigrationApprovalRequest,
  ROLE_PERMISSIONS,
  InMemoryMigrationApprovalRepository,
  DatabaseMigrationApprovalRepository,
  MigrationAccessControl,
  createMigrationApprovalRepository,
  MIGRATION_APPROVAL_SCHEMA,
} from './accessControl';
import {
  MigrationSecurityContext,
  MigrationSafetyConfig,
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
  MigrationAuthorizationError,
} from './types';
import { MigrationAuditLogger, InMemoryMigrationAuditRepository } from './audit';

describe('Migration Access Control & Tier Policies Suite', () => {
  const createMockSecurityContext = (
    overrides?: Partial<MigrationSecurityContext>
  ): MigrationSecurityContext => ({
    userId: 'user-123',
    userRole: 'developer',
    sessionId: 'session-456',
    requestId: 'req-789',
    environment: 'development',
    timestamp: new Date(),
    ipAddress: '127.0.0.1',
    userAgent: 'Revora-Test-Runner',
    ...overrides,
  });

  const createMockPool = (): jest.Mocked<Pool> => ({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    } as any),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: jest.fn(),
  } as any);

  let auditLogger: MigrationAuditLogger;
  let auditRepository: InMemoryMigrationAuditRepository;

  beforeEach(() => {
    auditRepository = new InMemoryMigrationAuditRepository();
    auditLogger = new MigrationAuditLogger(auditRepository);
  });

  describe('ROLE_PERMISSIONS Matrix', () => {
    it('defines accurate permission matrix for admin role', () => {
      const adminPerms = ROLE_PERMISSIONS.admin;
      expect(adminPerms.canRead).toBe(true);
      expect(adminPerms.canWrite).toBe(true);
      expect(adminPerms.canExecute).toBe(true);
      expect(adminPerms.canApprove).toBe(true);
      expect(adminPerms.canRollback).toBe(true);
      expect(adminPerms.maxRiskLevel).toBe('critical');
      expect(adminPerms.environments).toEqual(['development', 'staging', 'production']);
    });

    it('defines accurate permission matrix for dba role', () => {
      const dbaPerms = ROLE_PERMISSIONS.dba;
      expect(dbaPerms.canRead).toBe(true);
      expect(dbaPerms.canWrite).toBe(true);
      expect(dbaPerms.canExecute).toBe(true);
      expect(dbaPerms.canApprove).toBe(true);
      expect(dbaPerms.canRollback).toBe(true);
      expect(dbaPerms.maxRiskLevel).toBe('high');
      expect(dbaPerms.environments).toEqual(['development', 'staging', 'production']);
    });

    it('defines accurate permission matrix for developer role', () => {
      const devPerms = ROLE_PERMISSIONS.developer;
      expect(devPerms.canRead).toBe(true);
      expect(devPerms.canWrite).toBe(true);
      expect(devPerms.canExecute).toBe(true);
      expect(devPerms.canApprove).toBe(false);
      expect(devPerms.canRollback).toBe(false);
      expect(devPerms.maxRiskLevel).toBe('medium');
      expect(devPerms.environments).toEqual(['development', 'staging']);
    });

    it('defines accurate permission matrix for readonly role', () => {
      const readonlyPerms = ROLE_PERMISSIONS.readonly;
      expect(readonlyPerms.canRead).toBe(true);
      expect(readonlyPerms.canWrite).toBe(false);
      expect(readonlyPerms.canExecute).toBe(false);
      expect(readonlyPerms.canApprove).toBe(false);
      expect(readonlyPerms.canRollback).toBe(false);
      expect(readonlyPerms.maxRiskLevel).toBe('low');
      expect(readonlyPerms.environments).toEqual(['development', 'staging', 'production']);
    });
  });

  describe('InMemoryMigrationApprovalRepository', () => {
    let repo: InMemoryMigrationApprovalRepository;

    beforeEach(() => {
      repo = new InMemoryMigrationApprovalRepository();
    });

    it('creates and retrieves a migration approval request', async () => {
      const secCtx = createMockSecurityContext({ userRole: 'developer' });
      const request = await repo.createRequest({
        migrationId: 'mig-1',
        requesterId: 'user-123',
        requesterRole: 'developer',
        migrationFilename: '001_initial.sql',
        migrationRiskLevel: 'high',
        environment: 'staging',
        status: 'pending',
        securityContext: secCtx,
      });

      expect(request.id).toBeDefined();
      expect(request.status).toBe('pending');
      expect(request.requestedAt).toBeInstanceOf(Date);
      expect(request.expiresAt).toBeInstanceOf(Date);

      const fetched = await repo.getRequest(request.id);
      expect(fetched).toEqual(request);
    });

    it('returns null for non-existent request ID', async () => {
      const fetched = await repo.getRequest('invalid-id');
      expect(fetched).toBeNull();
    });

    it('updates request status and reviewer comments', async () => {
      const secCtx = createMockSecurityContext();
      const request = await repo.createRequest({
        migrationId: 'mig-2',
        requesterId: 'user-123',
        requesterRole: 'developer',
        migrationFilename: '002_add_index.sql',
        migrationRiskLevel: 'medium',
        environment: 'development',
        status: 'pending',
        securityContext: secCtx,
      });

      await repo.updateRequestStatus(request.id, 'approved', 'admin-999', 'Looks good to merge');

      const updated = await repo.getRequest(request.id);
      expect(updated?.status).toBe('approved');
      expect(updated?.reviewedBy).toBe('admin-999');
      expect(updated?.reviewComments).toBe('Looks good to merge');
      expect(updated?.reviewedAt).toBeInstanceOf(Date);
    });

    it('fetches pending requests filtered by environment sorted by requestedAt ASC', async () => {
      const secCtxDev = createMockSecurityContext({ environment: 'development' });
      const secCtxStg = createMockSecurityContext({ environment: 'staging' });

      const req1 = await repo.createRequest({
        migrationId: 'mig-1',
        requesterId: 'u1',
        requesterRole: 'developer',
        migrationFilename: '001.sql',
        migrationRiskLevel: 'low',
        environment: 'development',
        status: 'pending',
        securityContext: secCtxDev,
      });

      // Advance clock slightly for req2
      const req2 = await repo.createRequest({
        migrationId: 'mig-2',
        requesterId: 'u2',
        requesterRole: 'developer',
        migrationFilename: '002.sql',
        migrationRiskLevel: 'low',
        environment: 'development',
        status: 'pending',
        securityContext: secCtxDev,
      });

      await repo.createRequest({
        migrationId: 'mig-3',
        requesterId: 'u3',
        requesterRole: 'developer',
        migrationFilename: '003.sql',
        migrationRiskLevel: 'low',
        environment: 'staging',
        status: 'pending',
        securityContext: secCtxStg,
      });

      const devPending = await repo.getPendingRequests('development');
      expect(devPending.length).toBe(2);
      expect(devPending[0].id).toBe(req1.id);
      expect(devPending[1].id).toBe(req2.id);

      const pendingApprovals = await repo.getPendingApprovals('development');
      expect(pendingApprovals.length).toBe(2);
    });

    it('fetches user requests sorted by requestedAt DESC', async () => {
      const secCtx = createMockSecurityContext({ userId: 'target-user' });

      const req1 = await repo.createRequest({
        migrationId: 'mig-1',
        requesterId: 'target-user',
        requesterRole: 'developer',
        migrationFilename: '001.sql',
        migrationRiskLevel: 'low',
        environment: 'development',
        status: 'pending',
        securityContext: secCtx,
      });

      const req2 = await repo.createRequest({
        migrationId: 'mig-2',
        requesterId: 'target-user',
        requesterRole: 'developer',
        migrationFilename: '002.sql',
        migrationRiskLevel: 'low',
        environment: 'development',
        status: 'pending',
        securityContext: secCtx,
      });

      req1.requestedAt = new Date(Date.now() - 5000);
      req2.requestedAt = new Date(Date.now());

      const userRequests = await repo.getRequestsByUser('target-user');
      expect(userRequests.length).toBe(2);
      // Descending order -> req2 first
      expect(userRequests[0].id).toBe(req2.id);
      expect(userRequests[1].id).toBe(req1.id);
    });

    it('expires pending requests whose expiresAt timestamp has passed', async () => {
      const secCtx = createMockSecurityContext();
      const request = await repo.createRequest({
        migrationId: 'mig-expired',
        requesterId: 'user-1',
        requesterRole: 'developer',
        migrationFilename: '001.sql',
        migrationRiskLevel: 'medium',
        environment: 'development',
        status: 'pending',
        securityContext: secCtx,
      });

      // Manually set expiration in the past
      request.expiresAt = new Date(Date.now() - 10000);

      const expiredCount = await repo.expireRequests();
      expect(expiredCount).toBe(1);

      const fetched = await repo.getRequest(request.id);
      expect(fetched?.status).toBe('expired');
    });

    it('clears requests and fetches all requests correctly', async () => {
      const secCtx = createMockSecurityContext();
      await repo.createRequest({
        migrationId: 'mig-clear',
        requesterId: 'u1',
        requesterRole: 'developer',
        migrationFilename: '001.sql',
        migrationRiskLevel: 'low',
        environment: 'development',
        status: 'pending',
        securityContext: secCtx,
      });

      expect(repo.getAllRequests().length).toBe(1);
      repo.clear();
      expect(repo.getAllRequests().length).toBe(0);
    });
  });

  describe('DatabaseMigrationApprovalRepository', () => {
    let mockPool: jest.Mocked<Pool>;
    let repo: DatabaseMigrationApprovalRepository;

    beforeEach(() => {
      mockPool = createMockPool();
      repo = new DatabaseMigrationApprovalRepository(mockPool);
    });

    it('creates request by inserting record into PostgreSQL pool', async () => {
      const secCtx = createMockSecurityContext();
      const mockRow = {
        id: 'uuid-1234',
        migration_id: 'mig-101',
        requester_id: 'user-1',
        requester_role: 'developer',
        migration_filename: '001.sql',
        migration_risk_level: 'high',
        environment: 'staging',
        status: 'pending',
        requested_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        security_context: JSON.stringify(secCtx),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 } as any);

      const created = await repo.createRequest({
        migrationId: 'mig-101',
        requesterId: 'user-1',
        requesterRole: 'developer',
        migrationFilename: '001.sql',
        migrationRiskLevel: 'high',
        environment: 'staging',
        status: 'pending',
        securityContext: secCtx,
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO migration_approval_requests'),
        expect.arrayContaining(['mig-101', 'user-1', 'developer', '001.sql', 'high', 'staging', 'pending'])
      );
      expect(created.id).toBe('uuid-1234');
      expect(created.requesterRole).toBe('developer');
    });

    it('updates request status in database', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repo.updateRequestStatus('req-1', 'approved', 'admin-1', 'Approved for release');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE migration_approval_requests'),
        ['approved', 'admin-1', 'Approved for release', 'req-1']
      );
    });

    it('gets request by id from database', async () => {
      const secCtx = createMockSecurityContext();
      const mockRow = {
        id: 'req-1',
        migration_id: 'mig-1',
        requester_id: 'u1',
        requester_role: 'admin',
        migration_filename: '001.sql',
        migration_risk_level: 'critical',
        environment: 'production',
        status: 'approved',
        requested_at: new Date().toISOString(),
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'admin-2',
        reviewer_role: 'admin',
        review_comments: 'OK',
        expires_at: new Date().toISOString(),
        security_context: secCtx, // object form
      };

      mockPool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 } as any);

      const res = await repo.getRequest('req-1');
      expect(res).not.toBeNull();
      expect(res?.id).toBe('req-1');
      expect(res?.reviewedBy).toBe('admin-2');

      // Test null when not found
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      const resNull = await repo.getRequest('non-existent');
      expect(resNull).toBeNull();
    });

    it('gets pending requests and pending approvals from database', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await repo.getPendingRequests('staging');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = \'pending\' AND environment = $1'),
        ['staging']
      );

      await repo.getPendingApprovals('staging');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = \'pending\' AND environment = $1'),
        ['staging']
      );
    });

    it('gets requests by user from database', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repo.getRequestsByUser('user-42');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE requester_id = $1'),
        ['user-42']
      );
    });

    it('expires pending requests in database and returns rowCount', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 5 } as any);

      const count = await repo.expireRequests();
      expect(count).toBe(5);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'expired'")
      );
    });
  });

  describe('createMigrationApprovalRepository Factory', () => {
    it('returns injected repository when present on pool', () => {
      const customRepo = new InMemoryMigrationApprovalRepository();
      const mockPool: any = { __migrationApprovalRepository: customRepo };

      const result = createMigrationApprovalRepository(mockPool, 'production');
      expect(result).toBe(customRepo);
    });

    it('instantiates DatabaseMigrationApprovalRepository in production environment with pool', () => {
      const mockPool = createMockPool();
      const result = createMigrationApprovalRepository(mockPool, 'production');
      expect(result).toBeInstanceOf(DatabaseMigrationApprovalRepository);
    });

    it('instantiates InMemoryMigrationApprovalRepository in development environment', () => {
      const result = createMigrationApprovalRepository(undefined, 'development');
      expect(result).toBeInstanceOf(InMemoryMigrationApprovalRepository);
    });

    it('uses process.env.NODE_ENV when environment is omitted', () => {
      const result = createMigrationApprovalRepository();
      expect(result).toBeInstanceOf(InMemoryMigrationApprovalRepository);
    });
  });

  describe('MIGRATION_APPROVAL_SCHEMA', () => {
    it('contains valid database table schema definition', () => {
      expect(MIGRATION_APPROVAL_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS migration_approval_requests');
      expect(MIGRATION_APPROVAL_SCHEMA).toContain("CHECK (requester_role IN ('admin', 'dba', 'developer', 'readonly'))");
      expect(MIGRATION_APPROVAL_SCHEMA).toContain("CHECK (status IN ('pending', 'approved', 'rejected', 'expired'))");
      expect(MIGRATION_APPROVAL_SCHEMA).toContain('CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_env');
    });
  });

  describe('MigrationAccessControl Core Logic', () => {
    let approvalRepo: InMemoryMigrationApprovalRepository;
    let accessControl: MigrationAccessControl;

    beforeEach(() => {
      approvalRepo = new InMemoryMigrationApprovalRepository();
      accessControl = new MigrationAccessControl(
        approvalRepo,
        auditLogger,
        DEFAULT_MIGRATION_SAFETY_CONFIGS.development
      );
    });

    describe('canExecuteMigration', () => {
      it('allows execution for admin role within allowed risk level', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'admin', environment: 'development' });
        const res = await accessControl.canExecuteMigration(secCtx, 'critical');
        expect(res.allowed).toBe(true);
      });

      it('allows execution for dba role within high risk level', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'dba', environment: 'production' });
        const res = await accessControl.canExecuteMigration(secCtx, 'high');
        expect(res.allowed).toBe(true);
      });

      it('allows execution for developer role in staging within medium risk level', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'staging' });
        const res = await accessControl.canExecuteMigration(secCtx, 'medium');
        expect(res.allowed).toBe(true);
      });

      it('denies execution and logs violation for unknown/invalid user role', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'superhero' });
        const res = await accessControl.canExecuteMigration(secCtx, 'low');
        
        expect(res.allowed).toBe(false);
        expect(res.reason).toContain('Unknown user role: superhero');

        const events = await auditRepository.getAuditEvents();
        const violations = events.filter(e => e.type === 'security_violation');
        expect(violations.length).toBe(1);
        expect(violations[0].details.userRole).toBe('superhero');
      });

      it('denies execution for readonly role because canExecute is false', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'readonly', environment: 'development' });
        const res = await accessControl.canExecuteMigration(secCtx, 'low');

        expect(res.allowed).toBe(false);
        expect(res.reason).toBe('Role does not have execution permission');
      });

      it('denies execution for developer role in production environment', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'production' });
        const res = await accessControl.canExecuteMigration(secCtx, 'low');

        expect(res.allowed).toBe(false);
        expect(res.reason).toBe('Role not allowed in environment: production');
      });

      it('denies execution and requires approval when risk level exceeds role limit', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
        const res = await accessControl.canExecuteMigration(secCtx, 'critical');

        expect(res.allowed).toBe(false);
        expect(res.approvalRequired).toBe(true);
        expect(res.reason).toContain('Risk level critical exceeds maximum allowed medium; approval required');
      });

      it('denies execution and requires approval when safety config enforces approval and user cannot approve', async () => {
        const strictConfig: MigrationSafetyConfig = {
          ...DEFAULT_MIGRATION_SAFETY_CONFIGS.development,
          requireApproval: true,
        };
        const strictAccessControl = new MigrationAccessControl(approvalRepo, auditLogger, strictConfig);

        const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
        const res = await strictAccessControl.canExecuteMigration(secCtx, 'low');

        expect(res.allowed).toBe(false);
        expect(res.approvalRequired).toBe(true);
        expect(res.reason).toBe('Approval required but user cannot approve migrations');
      });

      it('handles timeRestrictions when user role specifies time windows', async () => {
        // Temporarily mutate ROLE_PERMISSIONS to test time restriction behavior safely
        const originalPerms = { ...ROLE_PERMISSIONS.developer };
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay();

        // Create time window excluding current hour
        const prohibitedStart = (currentHour + 2) % 24;
        const prohibitedEnd = (currentHour + 3) % 24;

        (ROLE_PERMISSIONS as any).developer = {
          ...originalPerms,
          timeRestrictions: {
            startHour: prohibitedStart,
            endHour: prohibitedEnd,
            daysOfWeek: [currentDay],
          },
        };

        try {
          const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
          const res = await accessControl.canExecuteMigration(secCtx, 'low');

          expect(res.allowed).toBe(false);
          expect(res.reason).toContain('Migration not allowed at this time');
        } finally {
          (ROLE_PERMISSIONS as any).developer = originalPerms;
        }
      });

      it('allows execution when current time is within time restrictions window', async () => {
        const originalPerms = { ...ROLE_PERMISSIONS.developer };
        const now = new Date();
        const currentHour = now.getHours();
        const currentDay = now.getDay();

        (ROLE_PERMISSIONS as any).developer = {
          ...originalPerms,
          timeRestrictions: {
            startHour: 0,
            endHour: 23,
            daysOfWeek: [currentDay],
          },
        };

        try {
          const secCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
          const res = await accessControl.canExecuteMigration(secCtx, 'low');

          expect(res.allowed).toBe(true);
        } finally {
          (ROLE_PERMISSIONS as any).developer = originalPerms;
        }
      });
    });

    describe('Approval Workflow & State Transitions', () => {
      it('creates an approval request successfully', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer' });
        const req = await accessControl.createApprovalRequest('mig-1', '001_schema.sql', 'high', secCtx);

        expect(req.id).toBeDefined();
        expect(req.migrationId).toBe('mig-1');
        expect(req.requesterRole).toBe('developer');
        expect(req.status).toBe('pending');
      });

      it('approves a pending migration request by authorized approver (admin)', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer' });
        const req = await accessControl.createApprovalRequest('mig-2', '002_data.sql', 'high', secCtx);

        await accessControl.approveMigrationRequest(req.id, 'admin-1', 'admin', 'Approved for deploy');

        const updated = await approvalRepo.getRequest(req.id);
        expect(updated?.status).toBe('approved');
        expect(updated?.reviewedBy).toBe('admin-1');
        expect(updated?.reviewComments).toBe('Approved for deploy');
      });

      it('throws MigrationAuthorizationError if approval request ID does not exist', async () => {
        await expect(
          accessControl.approveMigrationRequest('non-existent-id', 'admin-1', 'admin')
        ).rejects.toThrow(MigrationAuthorizationError);
      });

      it('throws MigrationAuthorizationError if trying to approve a non-pending request', async () => {
        const secCtx = createMockSecurityContext();
        const req = await accessControl.createApprovalRequest('mig-3', '003.sql', 'high', secCtx);

        await accessControl.approveMigrationRequest(req.id, 'admin-1', 'admin');

        // Second approval attempt
        await expect(
          accessControl.approveMigrationRequest(req.id, 'admin-1', 'admin')
        ).rejects.toThrow('Request is not pending');
      });

      it('throws MigrationAuthorizationError if approver role lacks approval permissions', async () => {
        const secCtx = createMockSecurityContext();
        const req = await accessControl.createApprovalRequest('mig-4', '004.sql', 'high', secCtx);

        await expect(
          accessControl.approveMigrationRequest(req.id, 'dev-2', 'developer')
        ).rejects.toThrow('Approver does not have approval permission');
      });

      it('rejects a pending migration request by authorized approver (dba)', async () => {
        const secCtx = createMockSecurityContext({ userRole: 'developer' });
        const req = await accessControl.createApprovalRequest('mig-5', '005_drop.sql', 'critical', secCtx);

        await accessControl.rejectMigrationRequest(req.id, 'dba-1', 'dba', 'Too risky for current release');

        const updated = await approvalRepo.getRequest(req.id);
        expect(updated?.status).toBe('rejected');
        expect(updated?.reviewedBy).toBe('dba-1');
        expect(updated?.reviewComments).toBe('Too risky for current release');
      });

      it('throws MigrationAuthorizationError on reject for invalid request ID or non-pending status or unauthorized rejector', async () => {
        const secCtx = createMockSecurityContext();
        const req = await accessControl.createApprovalRequest('mig-6', '006.sql', 'high', secCtx);

        // Non-existent request
        await expect(
          accessControl.rejectMigrationRequest('missing-id', 'admin-1', 'admin')
        ).rejects.toThrow('Approval request not found');

        // Unauthorized rejector
        await expect(
          accessControl.rejectMigrationRequest(req.id, 'dev-1', 'developer')
        ).rejects.toThrow('Rejector does not have approval permission');

        // Already rejected
        await accessControl.rejectMigrationRequest(req.id, 'admin-1', 'admin');
        await expect(
          accessControl.rejectMigrationRequest(req.id, 'admin-1', 'admin')
        ).rejects.toThrow('Request is not pending');
      });
    });

    describe('hasValidApproval', () => {
      it('returns true automatically for roles that can approve (admin/dba)', async () => {
        const adminCtx = createMockSecurityContext({ userRole: 'admin' });
        const dbaCtx = createMockSecurityContext({ userRole: 'dba' });

        const adminRes = await accessControl.hasValidApproval('mig-any', adminCtx);
        expect(adminRes.approved).toBe(true);

        const dbaRes = await accessControl.hasValidApproval('mig-any', dbaCtx);
        expect(dbaRes.approved).toBe(true);
      });

      it('returns false for non-approving roles when no approval request exists', async () => {
        const devCtx = createMockSecurityContext({ userRole: 'developer' });
        const res = await accessControl.hasValidApproval('mig-none', devCtx);
        expect(res.approved).toBe(false);
      });

      it('returns true when valid non-expired approval request exists in environment', async () => {
        const devCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
        const req = await accessControl.createApprovalRequest('mig-valid', '001.sql', 'high', devCtx);

        await accessControl.approveMigrationRequest(req.id, 'admin-1', 'admin');

        const res = await accessControl.hasValidApproval('mig-valid', devCtx);
        expect(res.approved).toBe(true);
        expect(res.approval?.id).toBe(req.id);
      });

      it('returns false when approval request has expired', async () => {
        const devCtx = createMockSecurityContext({ userRole: 'developer', environment: 'development' });
        const req = await accessControl.createApprovalRequest('mig-exp', '001.sql', 'high', devCtx);

        await accessControl.approveMigrationRequest(req.id, 'admin-1', 'admin');

        // Manually set expiration in past
        const rawReq = await approvalRepo.getRequest(req.id);
        if (rawReq) {
          rawReq.expiresAt = new Date(Date.now() - 5000);
        }

        const res = await accessControl.hasValidApproval('mig-exp', devCtx);
        expect(res.approved).toBe(false);
      });
    });

    describe('Delegation Methods', () => {
      it('delegates getPendingRequests, getUserRequests, and cleanupExpiredRequests to repo', async () => {
        const devCtx = createMockSecurityContext({ userId: 'dev-10', environment: 'staging' });
        const req = await accessControl.createApprovalRequest('mig-del', 'del.sql', 'high', devCtx);

        const pending = await accessControl.getPendingRequests('staging');
        expect(pending.length).toBe(1);
        expect(pending[0].id).toBe(req.id);

        const userReqs = await accessControl.getUserRequests('dev-10');
        expect(userReqs.length).toBe(1);

        req.expiresAt = new Date(Date.now() - 1000);
        const expiredCount = await accessControl.cleanupExpiredRequests();
        expect(expiredCount).toBe(1);
      });
    });
  });
});
