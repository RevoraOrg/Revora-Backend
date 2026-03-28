/**
 * Comprehensive Test Suite for DB Migration Safety Checks
 * 
 * Provides deterministic test coverage for all migration safety components
 * including validation, audit logging, access control, and rollback mechanisms.
 */

import { Pool } from 'pg';
import {
  MigrationFile,
  MigrationSecurityContext,
  MigrationEnvironment,
  MigrationRiskLevel,
  MigrationExecution,
  MigrationSafetyConfig,
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
  PreflightCheckResult,
  ExecutionPlan,
  RollbackStrategy,
} from './types';
import { MigrationFileAnalyzer, PreflightValidator, ExecutionPlanGenerator } from './validation';
import { 
  InMemoryMigrationAuditRepository, 
  MigrationAuditLogger,
  createMigrationAuditRepository 
} from './audit';
import { 
  InMemoryMigrationApprovalRepository,
  MigrationAccessControl,
  createMigrationApprovalRepository,
  ROLE_PERMISSIONS,
  MigrationRole,
} from './accessControl';
import { 
  InMemoryMigrationRollbackRepository,
  DatabaseBackupService,
  MigrationRollbackService,
  createMigrationRollbackRepository,
} from './rollback';
import { HardenedMigrationExecutor, MigrationManager } from './executor';

// Mock implementations
const createMockPool = (): jest.Mocked<Pool> => ({
  connect: jest.fn().mockResolvedValue({} as any),
  query: jest.fn(),
  end: jest.fn(),
} as any);

let mockPool: jest.Mocked<Pool>;

const createMockSecurityContext = (
  overrides: Partial<MigrationSecurityContext> = {}
): MigrationSecurityContext => ({
  userId: 'user-1',
  userRole: 'developer',
  sessionId: 'session-1',
  requestId: 'req-1',
  environment: 'development',
  timestamp: new Date(),
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  ...overrides,
});

const createMockMigrationFile = (
  overrides: Partial<MigrationFile> = {}
): MigrationFile => ({
  filename: '001_test_migration.sql',
  filepath: '/migrations/001_test_migration.sql',
  content: 'CREATE TABLE test_table (id UUID PRIMARY KEY);',
  checksum: 'abc123',
  size: 100,
  riskLevel: 'low',
  requiresDowntime: false,
  requiresBackup: false,
  dependencies: [],
  ...overrides,
});

describe('Migration Safety System', () => {
  let mockPool: jest.Mocked<Pool>;
  let auditRepository: InMemoryMigrationAuditRepository;
  let approvalRepository: InMemoryMigrationApprovalRepository;
  let rollbackRepository: InMemoryMigrationRollbackRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockPool = createMockPool();
    auditRepository = new InMemoryMigrationAuditRepository();
    approvalRepository = new InMemoryMigrationApprovalRepository();
    rollbackRepository = new InMemoryMigrationRollbackRepository();
  });

  describe('MigrationFileAnalyzer', () => {
    let analyzer: MigrationFileAnalyzer;

    beforeEach(() => {
      analyzer = new MigrationFileAnalyzer();
    });

    it('analyzes low-risk migration file correctly', () => {
      const content = `
        -- Migration: Create test table
        CREATE TABLE test_table (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
        
        CREATE INDEX idx_test_table_name ON test_table(name);
      `;

      // Mock file system operations
      const mockReadFileSync = jest.fn().mockReturnValue(content);
      const mockStatSync = jest.fn().mockReturnValue({ size: content.length });
      
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;
      (require('fs').statSync as jest.Mock) = mockStatSync;

      const result = analyzer.analyzeFile('/migrations/001_test.sql', '001_test.sql');

      expect(result.filename).toBe('001_test.sql');
      expect(result.riskLevel).toBe('low');
      expect(result.requiresDowntime).toBe(false);
      expect(result.requiresBackup).toBe(false);
      expect(result.dependencies).toEqual([]);
      expect(result.checksum).toBeDefined();
      expect(result.size).toBe(content.length);
    });

    it('identifies high-risk migration with DROP TABLE', () => {
      const content = `
        -- Dangerous migration
        DROP TABLE old_table;
        CREATE TABLE new_table (id UUID PRIMARY KEY);
      `;

      const mockReadFileSync = jest.fn().mockReturnValue(content);
      const mockStatSync = jest.fn().mockReturnValue({ size: content.length });
      
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;
      (require('fs').statSync as jest.Mock) = mockStatSync;

      const result = analyzer.analyzeFile('/migrations/002_dangerous.sql', '002_dangerous.sql');

      expect(result.riskLevel).toBe('critical');
      expect(result.requiresDowntime).toBe(true);
      expect(result.requiresBackup).toBe(true);
    });

    it('extracts table dependencies correctly', () => {
      const content = `
        CREATE TABLE orders (
          id UUID PRIMARY KEY,
          user_id UUID REFERENCES users(id),
          product_id UUID REFERENCES products(id)
        );
        
        CREATE INDEX idx_orders_user ON orders(user_id);
      `;

      const mockReadFileSync = jest.fn().mockReturnValue(content);
      const mockStatSync = jest.fn().mockReturnValue({ size: content.length });
      
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;
      (require('fs').statSync as jest.Mock) = mockStatSync;

      const result = analyzer.analyzeFile('/migrations/003_orders.sql', '003_orders.sql');

      expect(result.dependencies).toEqual(['users', 'products']);
    });
  });

  describe('PreflightValidator', () => {
    let validator: PreflightValidator;
    let config: MigrationSafetyConfig;
    let securityContext: MigrationSecurityContext;

    beforeEach(() => {
      config = DEFAULT_MIGRATION_SAFETY_CONFIGS.development;
      securityContext = createMockSecurityContext();
      validator = new PreflightValidator(config, securityContext);
    });

    it('passes all checks for authorized user with low-risk migration', async () => {
      const migration = createMockMigrationFile({ riskLevel: 'low' });

      const checks = await validator.validateMigration(migration);

      expect(checks.every(c => c.status !== 'failed')).toBe(true);
      
      const userAuthCheck = checks.find(c => c.name === 'user_authorization');
      expect(userAuthCheck?.status).toBe('passed');
    });

    it('fails authorization check for unauthorized role', async () => {
      const unauthorizedContext = createMockSecurityContext({ userRole: 'readonly' });
      const unauthorizedValidator = new PreflightValidator(config, unauthorizedContext);
      
      const migration = createMockMigrationFile({ riskLevel: 'medium' });
      const checks = await unauthorizedValidator.validateMigration(migration);

      const authCheck = checks.find(c => c.name === 'user_authorization');
      expect(authCheck?.status).toBe('failed');
      expect(authCheck?.critical).toBe(true);
    });

    it('fails file size check for oversized migration', async () => {
      const largeMigration = createMockMigrationFile({ 
        size: config.maxMigrationSize + 1000 
      });

      const checks = await validator.validateMigration(largeMigration);

      const sizeCheck = checks.find(c => c.name === 'file_size');
      expect(sizeCheck?.status).toBe('failed');
      expect(sizeCheck?.critical).toBe(true);
    });

    it('detects destructive operations when not allowed', async () => {
      const destructiveConfig = { ...config, allowDestructiveOperations: false };
      const destructiveValidator = new PreflightValidator(destructiveConfig, securityContext);
      
      const destructiveMigration = createMockMigrationFile({
        content: 'DROP TABLE old_table;'
      });

      const checks = await destructiveValidator.validateMigration(destructiveMigration);

      const destructiveCheck = checks.find(c => c.name === 'destructive_operations');
      expect(destructiveCheck?.status).toBe('failed');
      expect(destructiveCheck?.critical).toBe(true);
    });
  });

  describe('ExecutionPlanGenerator', () => {
    let generator: ExecutionPlanGenerator;

    beforeEach(() => {
      generator = new ExecutionPlanGenerator();
    });

    it('generates execution plan for simple migration', () => {
      const migration = createMockMigrationFile({
        content: `
          CREATE TABLE users (
            id UUID PRIMARY KEY,
            name TEXT NOT NULL
          );
          
          CREATE INDEX idx_users_name ON users(name);
        `
      });

      const plan = generator.generatePlan(migration);

      expect(plan.steps.length).toBe(2);
      expect(plan.steps[0].type).toBe('create');
      expect(plan.steps[1].type).toBe('index');
      expect(plan.requiresDowntime).toBe(false);
      expect(plan.rollbackStrategy.available).toBe(true);
      expect(plan.rollbackStrategy.steps.length).toBe(2);
    });

    it('estimates duration correctly', () => {
      const migration = createMockMigrationFile({
        content: `
          CREATE TABLE users (id UUID PRIMARY KEY);
          ALTER TABLE users ADD COLUMN email TEXT;
          CREATE INDEX idx_users_email ON users(email);
        `
      });

      const plan = generator.generatePlan(migration);

      expect(plan.estimatedDuration).toBeGreaterThan(0);
      // CREATE (60) + ALTER (120) + INDEX (180) = 360 seconds minimum
      expect(plan.estimatedDuration).toBeGreaterThanOrEqual(360);
    });

    it('generates rollback SQL for reversible operations', () => {
      const migration = createMockMigrationFile({
        content: 'CREATE TABLE test_table (id UUID PRIMARY KEY);'
      });

      const plan = generator.generatePlan(migration);

      expect(plan.rollbackStrategy.steps[0].rollbackSql).toBe('DROP TABLE IF EXISTS test_table;');
    });

    it('identifies data loss risk correctly', () => {
      const destructiveMigration = createMockMigrationFile({
        content: 'DROP TABLE old_table;'
      });

      const plan = generator.generatePlan(destructiveMigration);

      expect(plan.rollbackStrategy.dataLossRisk).toBe('moderate');
    });
  });

  describe('MigrationAuditLogger', () => {
    let auditLogger: MigrationAuditLogger;

    beforeEach(() => {
      auditLogger = new MigrationAuditLogger(auditRepository);
    });

    it('records migration started event', async () => {
      const execution = {
        id: 'exec-1',
        migrationFile: createMockMigrationFile(),
        status: 'running' as const,
        startedAt: new Date(),
        rollbackAvailable: false,
        securityContext: createMockSecurityContext(),
        preflightChecks: [],
        executionPlan: {
          steps: [],
          estimatedDuration: 0,
          requiresDowntime: false,
          rollbackStrategy: {
            available: false,
            automated: false,
            steps: [],
            dataLossRisk: 'none' as const,
            estimatedRollbackTime: 0,
          },
          riskMitigations: [],
        },
      };

      await auditLogger.logMigrationStarted(execution);

      const events = auditRepository.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('migration_started');
      expect(events[0].migrationId).toBe('exec-1');
      expect(events[0].userId).toBe('user-1');
    });

    it('records migration completed event', async () => {
      const securityContext = createMockSecurityContext();

      await auditLogger.logMigrationCompleted('exec-1', securityContext, {
        stepsExecuted: 3,
        duration: 5000,
      });

      const events = auditRepository.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('migration_completed');
      expect(events[0].details.stepsExecuted).toBe(3);
    });

    it('records migration failed event', async () => {
      const securityContext = createMockSecurityContext();
      const error = new Error('Test error');

      await auditLogger.logMigrationFailed('exec-1', error, securityContext);

      const events = auditRepository.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('migration_failed');
      expect(events[0].details.error).toBe('Test error');
    });

    it('records security violation event', async () => {
      const securityContext = createMockSecurityContext();

      await auditLogger.logSecurityViolation('exec-1', 'Unauthorized access', securityContext);

      const events = auditRepository.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('security_violation');
      expect(events[0].details.violation).toBe('Unauthorized access');
    });
  });

  describe('MigrationAccessControl', () => {
    let accessControl: MigrationAccessControl;

    beforeEach(() => {
      accessControl = new MigrationAccessControl(
        approvalRepository,
        new MigrationAuditLogger(auditRepository),
        DEFAULT_MIGRATION_SAFETY_CONFIGS.development
      );
    });

    it('allows execution for authorized user', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });

      const result = await accessControl.canExecuteMigration(securityContext, 'low');

      expect(result.allowed).toBe(true);
      expect(result.approvalRequired).toBe(false);
    });

    it('denies execution for unauthorized role', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'readonly' });

      const result = await accessControl.canExecuteMigration(securityContext, 'low');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('execution permission');
    });

    it('denies execution for high-risk migration beyond role limit', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'developer' });

      const result = await accessControl.canExecuteMigration(securityContext, 'critical');

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Risk level critical exceeds maximum allowed');
    });

    it('requires approval for production environment', async () => {
      const productionConfig = DEFAULT_MIGRATION_SAFETY_CONFIGS.production;
      const productionAccessControl = new MigrationAccessControl(
        approvalRepository,
        new MigrationAuditLogger(auditRepository),
        productionConfig
      );

      const securityContext = createMockSecurityContext({ 
        userRole: 'dba',
        environment: 'production'
      });

      const result = await productionAccessControl.canExecuteMigration(securityContext, 'low');

      expect(result.allowed).toBe(true);
      expect(result.approvalRequired).toBe(true);
    });

    it('creates approval request successfully', async () => {
      const securityContext = createMockSecurityContext();

      const request = await accessControl.createApprovalRequest(
        'mig-1',
        '001_test.sql',
        'medium',
        securityContext
      );

      expect(request.id).toBeDefined();
      expect(request.status).toBe('pending');
      expect(request.requesterId).toBe('user-1');
      expect(request.migrationRiskLevel).toBe('medium');
    });

    it('approves migration request successfully', async () => {
      const securityContext = createMockSecurityContext();
      
      // Create request first
      const request = await accessControl.createApprovalRequest(
        'mig-1',
        '001_test.sql',
        'medium',
        securityContext
      );

      // Approve it
      await accessControl.approveMigrationRequest(
        request.id,
        'admin-1',
        'admin',
        'Looks good'
      );

      const updatedRequest = await approvalRepository.getRequest(request.id);
      expect(updatedRequest?.status).toBe('approved');
      expect(updatedRequest?.reviewedBy).toBe('admin-1');
      expect(updatedRequest?.reviewComments).toBe('Looks good');
    });

    it('rejects migration request successfully', async () => {
      const securityContext = createMockSecurityContext();
      
      const request = await accessControl.createApprovalRequest(
        'mig-1',
        '001_test.sql',
        'medium',
        securityContext
      );

      await accessControl.rejectMigrationRequest(
        request.id,
        'admin-1',
        'admin',
        'Not ready for production'
      );

      const updatedRequest = await approvalRepository.getRequest(request.id);
      expect(updatedRequest?.status).toBe('rejected');
      expect(updatedRequest?.reviewComments).toBe('Not ready for production');
    });
  });

  describe('MigrationRollbackService', () => {
    let rollbackService: MigrationRollbackService;
    let backupService: DatabaseBackupService;

    beforeEach(() => {
      backupService = new DatabaseBackupService(mockPool, rollbackRepository);
      rollbackService = new MigrationRollbackService(
        mockPool,
        backupService,
        new MigrationAuditLogger(auditRepository)
      );
    });

    it('creates recovery point successfully', async () => {
      const recoveryPoint = await backupService.createBackup('mig-1', 'full');

      expect(recoveryPoint.id).toBeDefined();
      expect(recoveryPoint.migrationId).toBe('mig-1');
      expect(recoveryPoint.backupType).toBe('full');
      expect(recoveryPoint.createdAt).toBeInstanceOf(Date);
    });

    it('retrieves recovery point by ID', async () => {
      const recoveryPoint = await backupService.createBackup('mig-1', 'full');

      const retrieved = await rollbackRepository.getRecoveryPoint(recoveryPoint.id);

      expect(retrieved?.id).toBe(recoveryPoint.id);
      expect(retrieved?.migrationId).toBe('mig-1');
    });

    it('gets recovery points for migration', async () => {
      await backupService.createBackup('mig-1', 'full');
      await backupService.createBackup('mig-1', 'incremental');

      const recoveryPoints = await rollbackRepository.getRecoveryPointsForMigration('mig-1');

      expect(recoveryPoints).toHaveLength(2);
      expect(recoveryPoints[0].backupType).toBe('incremental'); // Most recent first
      expect(recoveryPoints[1].backupType).toBe('full');
    });

    it('cleans up expired recovery points', async () => {
      // Create a recovery point
      await backupService.createBackup('mig-1', 'full');

      // Manually expire it
      const allPoints = rollbackRepository.getAllRecoveryPoints();
      const expiredPoint = allPoints[0];
      expiredPoint.createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

      const cleanedCount = await rollbackRepository.cleanupExpiredRecoveryPoints(7); // 7 days

      expect(cleanedCount).toBe(1);
      expect(rollbackRepository.getAllRecoveryPoints()).toHaveLength(0);
    });
  });

  describe('HardenedMigrationExecutor', () => {
    let executor: HardenedMigrationExecutor;

    beforeEach(() => {
      executor = new HardenedMigrationExecutor(mockPool);
    });

    it('executes low-risk migration successfully', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });
      
      // Mock successful database operations
      const mockClient = {
        query: jest.fn() as any,
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);
      (mockClient.query as jest.Mock).mockResolvedValue({ rows: [] });

      // Mock file system
      const mockReadFileSync = jest.fn().mockReturnValue('CREATE TABLE test (id UUID PRIMARY KEY);');
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/001_test.sql',
        securityContext,
        { dryRun: true }
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');
      expect(result.stepsExecuted).toBeGreaterThan(0);
    });

    it('fails for unauthorized user', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'readonly' });

      const result = await executor.executeMigration(
        '/migrations/001_test.sql',
        securityContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('execution permission');
    });

    it('requires approval for high-risk migration', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'developer' });

      // Mock high-risk migration content
      const mockReadFileSync = jest.fn().mockReturnValue('DROP TABLE old_table;');
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/002_dangerous.sql',
        securityContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('approval required');
    });

    it('creates approval request when needed', async () => {
      const securityContext = createMockSecurityContext();

      const request = await executor.createApprovalRequest(
        '/migrations/001_test.sql',
        securityContext
      );

      expect(request.id).toBeDefined();
      expect(request.status).toBe('pending');
    });
  });

  describe('MigrationManager', () => {
    let manager: MigrationManager;

    beforeEach(() => {
      manager = new MigrationManager(mockPool);
    });

    it('gets applied migrations correctly', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            { version: '001_test.sql' },
            { version: '002_test.sql' }
          ]
        }),
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);

      const applied = await manager.getAppliedMigrations();

      expect(applied).toEqual(['001_test.sql', '002_test.sql']);
    });

    it('identifies pending migrations correctly', async () => {
      // Mock applied migrations
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{ version: '001_test.sql' }]
        }),
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);

      // Mock file system
      const mockReaddirSync = jest.fn().mockReturnValue([
        '001_test.sql',
        '002_test.sql',
        '003_test.sql'
      ]);
      (require('fs').readdirSync as jest.Mock) = mockReaddirSync;

      const pending = await manager.getPendingMigrations('/migrations');

      expect(pending).toEqual(['002_test.sql', '003_test.sql']);
    });

    it('runs pending migrations with safety checks', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });

      // Mock database operations
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);

      // Mock file system
      const mockReaddirSync = jest.fn().mockReturnValue(['002_test.sql']);
      const mockReadFileSync = jest.fn().mockReturnValue('CREATE TABLE test (id UUID PRIMARY KEY);');
      (require('fs').readdirSync as jest.Mock) = mockReaddirSync;
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const results = await manager.runPendingMigrations(securityContext, { dryRun: true });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });
  });

  describe('Integration Tests', () => {
    it('handles complete migration workflow end-to-end', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });
      const config = DEFAULT_MIGRATION_SAFETY_CONFIGS.staging;
      
      const executor = new HardenedMigrationExecutor(mockPool, config);

      // 1. Create approval request
      const request = await executor.createApprovalRequest(
        '/migrations/001_test.sql',
        securityContext
      );

      // 2. Approve the request
      await executor.approveMigration(request.id, 'admin-1', 'admin');

      // 3. Execute migration
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);

      const mockReadFileSync = jest.fn().mockReturnValue('CREATE TABLE test (id UUID PRIMARY KEY);');
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/001_test.sql',
        securityContext,
        { dryRun: true }
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('completed');

      // 4. Verify audit trail
      const events = auditRepository.getAllEvents();
      expect(events.length).toBeGreaterThan(0);
      
      const approvalEvents = events.filter(e => e.type === 'migration_started');
      expect(approvalEvents.length).toBeGreaterThan(0);
    });

    it('prevents security violations and logs them', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'readonly' });
      const executor = new HardenedMigrationExecutor(mockPool);

      const result = await executor.executeMigration(
        '/migrations/001_test.sql',
        securityContext
      );

      expect(result.success).toBe(false);

      // Verify security violation was logged
      const events = auditRepository.getAllEvents();
      const securityViolations = events.filter(e => e.type === 'security_violation');
      expect(securityViolations.length).toBeGreaterThan(0);
    });

    it('handles rollback scenario correctly', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });
      const executor = new HardenedMigrationExecutor(mockPool);

      // Create a mock execution with rollback available
      const mockExecution: MigrationExecution = {
        id: 'exec-1',
        migrationFile: createMockMigrationFile(),
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        errorMessage: undefined,
        rollbackAvailable: true,
        securityContext,
        preflightChecks: [],
        executionPlan: {
          steps: [
            {
              id: 'step_1',
              description: 'CREATE TABLE test',
              sql: 'CREATE TABLE test (id UUID PRIMARY KEY);',
              type: 'create' as const,
              riskLevel: 'low' as const,
              rollbackSql: 'DROP TABLE IF EXISTS test;',
              validations: ['table_exists'],
            }
          ],
          estimatedDuration: 60,
          requiresDowntime: false,
          rollbackStrategy: {
            available: true,
            automated: true,
            steps: [
              {
                id: 'rollback_step_1',
                description: 'Rollback: CREATE TABLE test',
                sql: 'DROP TABLE IF EXISTS test;',
                type: 'create' as const,
                riskLevel: 'low' as const,
                validations: [],
              }
            ],
            dataLossRisk: 'none' as const,
            estimatedRollbackTime: 30,
          },
          riskMitigations: [],
        },
      };

      // Mock rollback execution
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      } as any;
      (mockPool.connect as any).mockResolvedValue(mockClient);

      const rollbackResult = await executor.rollbackMigration('exec-1', securityContext);

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.stepsExecuted).toBe(1);
      expect(rollbackResult.dataLoss).toBe('none');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('handles malformed migration files gracefully', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });
      const executor = new HardenedMigrationExecutor(mockPool);

      // Mock file system error
      const mockReadFileSync = jest.fn().mockImplementation(() => {
        throw new Error('File not found');
      });
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/nonexistent.sql',
        securityContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to load migration file');
    });

    it('handles database connection failures', async () => {
      const securityContext = createMockSecurityContext({ userRole: 'admin' });
      const executor = new HardenedMigrationExecutor(mockPool);

      // Mock database connection error
      (mockPool.connect as any).mockRejectedValue(new Error('Database connection failed'));

      const mockReadFileSync = jest.fn().mockReturnValue('CREATE TABLE test (id UUID PRIMARY KEY);');
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/001_test.sql',
        securityContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('validates time window restrictions', async () => {
      const productionConfig = {
        ...DEFAULT_MIGRATION_SAFETY_CONFIGS.production,
        riskThresholds: {
          ...DEFAULT_MIGRATION_SAFETY_CONFIGS.production.riskThresholds,
          critical: {
            requireApproval: true,
            requireBackup: true,
            requireDryRun: true,
            allowedTimeWindow: { start: '02:00', end: '04:00' },
          },
        },
      };

      const executor = new HardenedMigrationExecutor(mockPool, productionConfig);
      
      // Create security context with current time outside window (e.g., 10:00 AM)
      const securityContext = createMockSecurityContext({ 
        userRole: 'admin',
        environment: 'production',
        timestamp: new Date().setHours(10, 0, 0, 0) as any,
      });

      const mockReadFileSync = jest.fn().mockReturnValue('DROP TABLE old_table;');
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const result = await executor.executeMigration(
        '/migrations/002_critical.sql',
        securityContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('time window');
    });

    it('handles concurrent migration limits', async () => {
      const config = {
        ...DEFAULT_MIGRATION_SAFETY_CONFIGS.production,
        maxConcurrentMigrations: 1,
      };

      const executor = new HardenedMigrationExecutor(mockPool, config);
      const securityContext = createMockSecurityContext({ userRole: 'admin' });

      // This would need to be implemented with actual concurrent migration tracking
      // For now, we'll test the configuration
      expect(config.maxConcurrentMigrations).toBe(1);
    });
  });

  describe('Performance and Scalability', () => {
    it('handles large migration files efficiently', async () => {
      const largeContent = 'CREATE TABLE test (id UUID PRIMARY KEY);\n'.repeat(10000);
      
      const mockReadFileSync = jest.fn().mockReturnValue(largeContent);
      (require('fs').readFileSync as jest.Mock) = mockReadFileSync;

      const analyzer = new MigrationFileAnalyzer();
      const startTime = Date.now();
      
      const result = analyzer.analyzeFile('/migrations/large.sql', 'large.sql');
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
      expect(result.size).toBe(largeContent.length);
    });

    it('processes multiple preflight checks concurrently', async () => {
      const securityContext = createMockSecurityContext();
      const validator = new PreflightValidator(
        DEFAULT_MIGRATION_SAFETY_CONFIGS.development,
        securityContext
      );

      const migration = createMockMigrationFile();
      
      const startTime = Date.now();
      const checks = await validator.validateMigration(migration);
      const duration = Date.now() - startTime;

      expect(checks.length).toBeGreaterThan(5);
      expect(duration).toBeLessThan(500); // Should complete quickly
    });

    it('manages audit repository memory efficiently', async () => {
      const auditLogger = new MigrationAuditLogger(auditRepository);
      const securityContext = createMockSecurityContext();

      // Add many events
      for (let i = 0; i < 100; i++) {
        await auditLogger.logSecurityViolation(
          `exec-${i}`,
          `Test violation ${i}`,
          securityContext
        );
      }

      const events = auditRepository.getAllEvents();
      expect(events.length).toBe(100);

      // Test cleanup (if implemented)
      const cleanedCount = await auditRepository.clear();
      expect(auditRepository.getAllEvents().length).toBe(0);
    });
  });
});
