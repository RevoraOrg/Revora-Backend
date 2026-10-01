/**
 * Comprehensive test suite for Migration Audit Repository
 *
 * Coverage Targets:
 * - MigrationAuditRepository interface implementations
 * - InMemoryMigrationAuditRepository: all methods and memory management
 * - DatabaseMigrationAuditRepository: all methods and database operations
 * - MigrationAuditLogger: all logging methods
 * - Success paths and error handling
 * - Edge cases and boundary conditions
 * - Memory leak prevention in InMemoryRepository
 * - Data consistency and integrity
 *
 * Security Assumptions:
 * - Database connections are properly authenticated and encrypted
 * - Audit events are tamper-evident through immutability
 * - Security context contains verified user information
 */

import {
  InMemoryMigrationAuditRepository,
  DatabaseMigrationAuditRepository,
  MigrationAuditLogger,
  createMigrationAuditRepository,
} from './audit';
import {
  MigrationAuditEvent,
  MigrationExecution,
  MigrationSecurityContext,
  MigrationStatus,
} from './types';
import { Pool, QueryResult } from 'pg';

describe('InMemoryMigrationAuditRepository', () => {
  let repository: InMemoryMigrationAuditRepository;

  beforeEach(() => {
    repository = new InMemoryMigrationAuditRepository();
  });

  function createMockSecurityContext(): MigrationSecurityContext {
    return {
      userId: 'user-123',
      userRole: 'admin',
      sessionId: 'session-123',
      requestId: 'req-123',
      environment: 'development',
      timestamp: new Date(),
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    };
  }

  function createMockAuditEvent(overrides: Partial<MigrationAuditEvent> = {}): MigrationAuditEvent {
    const securityContext = createMockSecurityContext();
    return {
      id: 'event-123',
      migrationId: 'migration-123',
      type: 'migration_started',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: { test: 'data' },
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
      ...overrides,
    };
  }

  function createMockExecution(overrides: Partial<MigrationExecution> = {}): MigrationExecution {
    return {
      id: 'exec-123',
      migrationFile: {
        filename: 'test-migration.sql',
        filepath: '/migrations/test-migration.sql',
        content: 'CREATE TABLE test (id INT);',
        checksum: 'abc123',
        size: 1024,
        riskLevel: 'low',
        requiresDowntime: false,
        requiresBackup: false,
        dependencies: [],
      },
      status: 'pending',
      startedAt: new Date(),
      rollbackAvailable: true,
      securityContext: createMockSecurityContext(),
      preflightChecks: [
        {
          name: 'syntax_check',
          status: 'passed',
          message: 'Syntax is valid',
          critical: true,
        },
      ],
      executionPlan: {
        steps: [],
        estimatedDuration: 60,
        requiresDowntime: false,
        rollbackStrategy: {
          available: true,
          automated: true,
          steps: [],
          dataLossRisk: 'none',
          estimatedRollbackTime: 30,
        },
        riskMitigations: [],
      },
      ...overrides,
    };
  }

  describe('recordEvent', () => {
    it('should record an audit event', async () => {
      const event = createMockAuditEvent();

      await repository.recordEvent(event);

      const events = repository.getAllEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
    });

    it('should record multiple audit events', async () => {
      const event1 = createMockAuditEvent({ id: 'event-1' });
      const event2 = createMockAuditEvent({ id: 'event-2' });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);

      const events = repository.getAllEvents();
      expect(events).toHaveLength(2);
      expect(events).toContainEqual(event1);
      expect(events).toContainEqual(event2);
    });

    it('should prevent memory leaks by limiting event storage', async () => {
      // Create more events than the max limit
      const eventCount = 11000; // More than maxEvents (10000)

      for (let i = 0; i < eventCount; i++) {
        await repository.recordEvent(createMockAuditEvent({ id: `event-${i}` }));
      }

      const events = repository.getAllEvents();
      expect(events.length).toBeLessThan(eventCount);
      expect(events.length).toBeLessThanOrEqual(10000);
    });

    it('should preserve recent events when trimming', async () => {
      for (let i = 0; i < 11000; i++) {
        await repository.recordEvent(createMockAuditEvent({ id: `event-${i}` }));
      }

      const events = repository.getAllEvents();
      // Should contain the most recent events
      expect(events.some(e => e.id === 'event-10999')).toBe(true);
    });
  });

  describe('recordExecution', () => {
    it('should record a migration execution', async () => {
      const execution = createMockExecution();

      await repository.recordExecution(execution);

      const executions = repository.getAllExecutions();
      expect(executions).toHaveLength(1);
      expect(executions[0]).toEqual(execution);
    });

    it('should record multiple executions', async () => {
      const exec1 = createMockExecution({ id: 'exec-1' });
      const exec2 = createMockExecution({ id: 'exec-2' });

      await repository.recordExecution(exec1);
      await repository.recordExecution(exec2);

      const executions = repository.getAllExecutions();
      expect(executions).toHaveLength(2);
    });

    it('should prevent memory leaks by limiting execution storage', async () => {
      const executionCount = 1200; // More than maxExecutions (1000)

      for (let i = 0; i < executionCount; i++) {
        await repository.recordExecution(createMockExecution({ id: `exec-${i}` }));
      }

      const executions = repository.getAllExecutions();
      expect(executions.length).toBeLessThan(executionCount);
      expect(executions.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('updateExecutionStatus', () => {
    it('should update execution status to completed', async () => {
      const execution = createMockExecution({ id: 'exec-update', status: 'running' });
      await repository.recordExecution(execution);

      await repository.updateExecutionStatus('exec-update', 'completed');

      const executions = repository.getAllExecutions();
      const updated = executions.find(e => e.id === 'exec-update');
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should update execution status to failed with error message', async () => {
      const execution = createMockExecution({ id: 'exec-fail', status: 'running' });
      await repository.recordExecution(execution);

      await repository.updateExecutionStatus('exec-fail', 'failed', 'Database connection failed');

      const executions = repository.getAllExecutions();
      const updated = executions.find(e => e.id === 'exec-fail');
      expect(updated?.status).toBe('failed');
      expect(updated?.errorMessage).toBe('Database connection failed');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should update execution status to rolled_back', async () => {
      const execution = createMockExecution({ id: 'exec-rollback', status: 'failed' });
      await repository.recordExecution(execution);

      await repository.updateExecutionStatus('exec-rollback', 'rolled_back');

      const executions = repository.getAllExecutions();
      const updated = executions.find(e => e.id === 'exec-rollback');
      expect(updated?.status).toBe('rolled_back');
      expect(updated?.completedAt).toBeDefined();
    });

    it('should handle non-existent execution gracefully', async () => {
      await repository.updateExecutionStatus('non-existent', 'completed');

      const executions = repository.getAllExecutions();
      expect(executions).toHaveLength(0);
    });

    it('should not set completedAt for non-terminal statuses', async () => {
      const execution = createMockExecution({ id: 'exec-running', status: 'pending' });
      await repository.recordExecution(execution);

      await repository.updateExecutionStatus('exec-running', 'running');

      const executions = repository.getAllExecutions();
      const updated = executions.find(e => e.id === 'exec-running');
      expect(updated?.status).toBe('running');
      expect(updated?.completedAt).toBeUndefined();
    });
  });

  describe('getExecutionHistory', () => {
    it('should return execution history sorted by most recent first', async () => {
      const exec1 = createMockExecution({ id: 'exec-1', startedAt: new Date('2024-01-01') });
      const exec2 = createMockExecution({ id: 'exec-2', startedAt: new Date('2024-01-02') });
      const exec3 = createMockExecution({ id: 'exec-3', startedAt: new Date('2024-01-03') });

      await repository.recordExecution(exec1);
      await repository.recordExecution(exec2);
      await repository.recordExecution(exec3);

      const history = await repository.getExecutionHistory();

      expect(history).toHaveLength(3);
      expect(history[0].id).toBe('exec-3');
      expect(history[1].id).toBe('exec-2');
      expect(history[2].id).toBe('exec-1');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await repository.recordExecution(createMockExecution({ id: `exec-${i}` }));
      }

      const history = await repository.getExecutionHistory(5);

      expect(history).toHaveLength(5);
    });

    it('should return empty array when no executions exist', async () => {
      const history = await repository.getExecutionHistory();

      expect(history).toEqual([]);
    });

    it('should default to limit of 100', async () => {
      for (let i = 0; i < 150; i++) {
        await repository.recordExecution(createMockExecution({ id: `exec-${i}` }));
      }

      const history = await repository.getExecutionHistory();

      expect(history).toHaveLength(100);
    });
  });

  describe('getAuditEvents', () => {
    it('should return all audit events when no filter provided', async () => {
      const event1 = createMockAuditEvent({ id: 'event-1', migrationId: 'migration-1' });
      const event2 = createMockAuditEvent({ id: 'event-2', migrationId: 'migration-2' });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);

      const events = await repository.getAuditEvents();

      expect(events).toHaveLength(2);
    });

    it('should filter events by migrationId', async () => {
      const event1 = createMockAuditEvent({ id: 'event-1', migrationId: 'migration-1' });
      const event2 = createMockAuditEvent({ id: 'event-2', migrationId: 'migration-2' });
      const event3 = createMockAuditEvent({ id: 'event-3', migrationId: 'migration-1' });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);
      await repository.recordEvent(event3);

      const events = await repository.getAuditEvents('migration-1');

      expect(events).toHaveLength(2);
      expect(events.every(e => e.migrationId === 'migration-1')).toBe(true);
    });

    it('should return events sorted by most recent first', async () => {
      const event1 = createMockAuditEvent({ id: 'event-1', timestamp: new Date('2024-01-01') });
      const event2 = createMockAuditEvent({ id: 'event-2', timestamp: new Date('2024-01-02') });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);

      const events = await repository.getAuditEvents();

      expect(events[0].id).toBe('event-2');
      expect(events[1].id).toBe('event-1');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await repository.recordEvent(createMockAuditEvent({ id: `event-${i}` }));
      }

      const events = await repository.getAuditEvents(undefined, 5);

      expect(events).toHaveLength(5);
    });
  });

  describe('getSecurityViolations', () => {
    it('should return only security violation events', async () => {
      const event1 = createMockAuditEvent({ id: 'event-1', type: 'migration_started' });
      const event2 = createMockAuditEvent({ id: 'event-2', type: 'security_violation' });
      const event3 = createMockAuditEvent({ id: 'event-3', type: 'security_violation' });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);
      await repository.recordEvent(event3);

      const violations = await repository.getSecurityViolations(new Date('2024-01-01'));

      expect(violations).toHaveLength(2);
      expect(violations.every(v => v.type === 'security_violation')).toBe(true);
    });

    it('should filter violations by date', async () => {
      const event1 = createMockAuditEvent({
        id: 'event-1',
        type: 'security_violation',
        timestamp: new Date('2024-01-01'),
      });
      const event2 = createMockAuditEvent({
        id: 'event-2',
        type: 'security_violation',
        timestamp: new Date('2024-01-15'),
      });

      await repository.recordEvent(event1);
      await repository.recordEvent(event2);

      const violations = await repository.getSecurityViolations(new Date('2024-01-10'));

      expect(violations).toHaveLength(1);
      expect(violations[0].id).toBe('event-2');
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await repository.recordEvent(
          createMockAuditEvent({ id: `event-${i}`, type: 'security_violation' })
        );
      }

      const violations = await repository.getSecurityViolations(new Date('2024-01-01'), 5);

      expect(violations).toHaveLength(5);
    });

    it('should return empty array when no violations exist', async () => {
      const event = createMockAuditEvent({ type: 'migration_started' });
      await repository.recordEvent(event);

      const violations = await repository.getSecurityViolations(new Date('2024-01-01'));

      expect(violations).toEqual([]);
    });
  });

  describe('clear', () => {
    it('should clear all events and executions', async () => {
      await repository.recordEvent(createMockAuditEvent());
      await repository.recordExecution(createMockExecution());

      repository.clear();

      expect(repository.getAllEvents()).toHaveLength(0);
      expect(repository.getAllExecutions()).toHaveLength(0);
    });
  });
});

describe('DatabaseMigrationAuditRepository', () => {
  let repository: DatabaseMigrationAuditRepository;
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
    } as any;

    repository = new DatabaseMigrationAuditRepository(mockPool);
  });

  function createMockSecurityContext(): MigrationSecurityContext {
    return {
      userId: 'user-123',
      userRole: 'admin',
      sessionId: 'session-123',
      requestId: 'req-123',
      environment: 'production',
      timestamp: new Date(),
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
    };
  }

  function createMockAuditEvent(overrides: Partial<MigrationAuditEvent> = {}): MigrationAuditEvent {
    const securityContext = createMockSecurityContext();
    return {
      id: 'event-db-123',
      migrationId: 'migration-db-123',
      type: 'migration_started',
      userId: securityContext.userId,
      environment: securityContext.environment,
      details: { test: 'data' },
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
      ...overrides,
    };
  }

  function createMockExecution(overrides: Partial<MigrationExecution> = {}): MigrationExecution {
    return {
      id: 'exec-db-123',
      migrationFile: {
        filename: 'prod-migration.sql',
        filepath: '/migrations/prod-migration.sql',
        content: 'ALTER TABLE users ADD COLUMN email VARCHAR(255);',
        checksum: 'xyz789',
        size: 2048,
        riskLevel: 'medium',
        requiresDowntime: true,
        requiresBackup: true,
        dependencies: ['migration-1'],
      },
      status: 'pending',
      startedAt: new Date(),
      rollbackAvailable: true,
      securityContext: createMockSecurityContext(),
      preflightChecks: [],
      executionPlan: {
        steps: [],
        estimatedDuration: 120,
        requiresDowntime: true,
        rollbackStrategy: {
          available: true,
          automated: false,
          steps: [],
          dataLossRisk: 'minimal',
          estimatedRollbackTime: 60,
        },
        riskMitigations: ['backup_required'],
      },
      ...overrides,
    };
  }

  describe('recordEvent', () => {
    it('should insert audit event into database', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      const event = createMockAuditEvent();
      await repository.recordEvent(event);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO migration_audit_events'),
        expect.arrayContaining([
          event.id,
          event.migrationId,
          event.type,
          event.userId,
          event.environment,
          expect.any(String), // JSON.stringify(details)
          expect.any(String), // JSON.stringify(securityContext)
          event.timestamp,
        ])
      );
    });

    it('should handle database errors', async () => {
      mockPool.query.mockRejectedValue(new Error('Database error'));

      const event = createMockAuditEvent();

      await expect(repository.recordEvent(event)).rejects.toThrow('Database error');
    });
  });

  describe('recordExecution', () => {
    it('should insert migration execution into database', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      const execution = createMockExecution();
      await repository.recordExecution(execution);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO migration_executions'),
        expect.arrayContaining([
          execution.id,
          execution.migrationFile.filename,
          execution.migrationFile.filepath,
          execution.migrationFile.checksum,
          execution.status,
          execution.startedAt,
          null, // completedAt
          null, // errorMessage
          execution.rollbackAvailable,
          expect.any(String), // preflightChecks JSON
          expect.any(String), // executionPlan JSON
          expect.any(String), // securityContext JSON
          execution.migrationFile.riskLevel,
          execution.migrationFile.requiresDowntime,
          execution.migrationFile.requiresBackup,
        ])
      );
    });

    it('should include completedAt if present', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      const completedAt = new Date('2024-01-15T10:00:00Z');
      const execution = createMockExecution({ completedAt });
      await repository.recordExecution(execution);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([completedAt])
      );
    });
  });

  describe('updateExecutionStatus', () => {
    it('should update execution status without error', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      await repository.updateExecutionStatus('exec-123', 'completed');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE migration_executions'),
        expect.arrayContaining(['completed', null, expect.any(Date), 'exec-123'])
      );
    });

    it('should update execution status with error message', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      await repository.updateExecutionStatus('exec-123', 'failed', 'SQL syntax error');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['failed', 'SQL syntax error', expect.any(Date), 'exec-123'])
      );
    });

    it('should set completedAt to null for non-terminal statuses', async () => {
      mockPool.query.mockResolvedValue({} as QueryResult);

      await repository.updateExecutionStatus('exec-123', 'running');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['running', null, null, 'exec-123'])
      );
    });
  });

  describe('getExecutionHistory', () => {
    it('should retrieve execution history from database', async () => {
      const mockRows = [
        {
          id: 'exec-1',
          migration_filename: 'test.sql',
          migration_filepath: '/test.sql',
          migration_checksum: 'abc',
          status: 'completed',
          started_at: new Date(),
          completed_at: new Date(),
          error_message: null,
          rollback_available: true,
          preflight_checks: JSON.stringify([]),
          execution_plan: JSON.stringify({ steps: [] }),
          security_context: JSON.stringify({ userId: 'user-1' }),
          risk_level: 'low',
          requires_downtime: false,
          requires_backup: false,
        },
      ];

      mockPool.query.mockResolvedValue({ rows: mockRows } as QueryResult);

      const history = await repository.getExecutionHistory(50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM migration_executions'),
        [50]
      );
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('exec-1');
    });

    it('should default to limit of 100', async () => {
      mockPool.query.mockResolvedValue({ rows: [] } as QueryResult);

      await repository.getExecutionHistory();

      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), [100]);
    });

    it('should parse JSON fields correctly', async () => {
      const preflightChecks = [{ name: 'test', status: 'passed', message: 'ok', critical: true }];
      const executionPlan = { steps: [], estimatedDuration: 60 };
      const securityContext = { userId: 'user-1', environment: 'production' };

      const mockRows = [
        {
          id: 'exec-1',
          migration_filename: 'test.sql',
          migration_filepath: '/test.sql',
          migration_checksum: 'abc',
          status: 'completed',
          started_at: new Date(),
          completed_at: new Date(),
          error_message: null,
          rollback_available: true,
          preflight_checks: JSON.stringify(preflightChecks),
          execution_plan: JSON.stringify(executionPlan),
          security_context: JSON.stringify(securityContext),
          risk_level: 'low',
          requires_downtime: false,
          requires_backup: false,
        },
      ];

      mockPool.query.mockResolvedValue({ rows: mockRows } as QueryResult);

      const history = await repository.getExecutionHistory();

      expect(history[0].preflightChecks).toEqual(preflightChecks);
      expect(history[0].executionPlan).toMatchObject(executionPlan);
      expect(history[0].securityContext).toMatchObject(securityContext);
    });
  });

  describe('getAuditEvents', () => {
    it('should retrieve audit events from database', async () => {
      const mockRows = [
        {
          id: 'event-1',
          migration_id: 'migration-1',
          type: 'migration_started',
          user_id: 'user-1',
          environment: 'production',
          details: JSON.stringify({ test: 'data' }),
          security_context: JSON.stringify({ userId: 'user-1' }),
          timestamp: new Date(),
        },
      ];

      mockPool.query.mockResolvedValue({ rows: mockRows } as QueryResult);

      const events = await repository.getAuditEvents('migration-1', 50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM migration_audit_events'),
        ['migration-1', 50]
      );
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('event-1');
    });

    it('should handle optional executionId parameter', async () => {
      mockPool.query.mockResolvedValue({ rows: [] } as QueryResult);

      await repository.getAuditEvents(undefined, 100);

      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), [null, 100]);
    });
  });

  describe('getSecurityViolations', () => {
    it('should retrieve security violations from database', async () => {
      const since = new Date('2024-01-01');
      const mockRows = [
        {
          id: 'violation-1',
          migration_id: 'migration-1',
          type: 'security_violation',
          user_id: 'user-1',
          environment: 'production',
          details: JSON.stringify({ violation: 'unauthorized_access' }),
          security_context: JSON.stringify({ userId: 'user-1' }),
          timestamp: new Date('2024-01-15'),
        },
      ];

      mockPool.query.mockResolvedValue({ rows: mockRows } as QueryResult);

      const violations = await repository.getSecurityViolations(since, 50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("type = 'security_violation'"),
        [since, 50]
      );
      expect(violations).toHaveLength(1);
      expect(violations[0].type).toBe('security_violation');
    });

    it('should default to limit of 100', async () => {
      mockPool.query.mockResolvedValue({ rows: [] } as QueryResult);

      await repository.getSecurityViolations(new Date());

      expect(mockPool.query).toHaveBeenCalledWith(expect.any(String), [expect.any(Date), 100]);
    });
  });
});

describe('MigrationAuditLogger', () => {
  let logger: MigrationAuditLogger;
  let mockRepository: jest.Mocked<InMemoryMigrationAuditRepository>;

  beforeEach(() => {
    mockRepository = {
      recordEvent: jest.fn(),
      recordExecution: jest.fn(),
      updateExecutionStatus: jest.fn(),
      getExecutionHistory: jest.fn(),
      getAuditEvents: jest.fn(),
      getSecurityViolations: jest.fn(),
    } as any;

    logger = new MigrationAuditLogger(mockRepository);
  });

  function createMockSecurityContext(): MigrationSecurityContext {
    return {
      userId: 'user-logger',
      userRole: 'dba',
      sessionId: 'session-logger',
      requestId: 'req-logger',
      environment: 'staging',
      timestamp: new Date(),
      ipAddress: '10.0.0.1',
      userAgent: 'migration-tool/1.0',
    };
  }

  function createMockExecution(overrides: Partial<MigrationExecution> = {}): MigrationExecution {
    return {
      id: 'exec-logger-123',
      migrationFile: {
        filename: 'logger-test.sql',
        filepath: '/migrations/logger-test.sql',
        content: 'SELECT 1;',
        checksum: 'logger-checksum',
        size: 512,
        riskLevel: 'low',
        requiresDowntime: false,
        requiresBackup: false,
        dependencies: [],
      },
      status: 'pending',
      startedAt: new Date(),
      rollbackAvailable: true,
      securityContext: createMockSecurityContext(),
      preflightChecks: [
        {
          name: 'backup_check',
          status: 'passed',
          message: 'Backup completed',
          critical: true,
        },
      ],
      executionPlan: {
        steps: [],
        estimatedDuration: 30,
        requiresDowntime: false,
        rollbackStrategy: {
          available: true,
          automated: true,
          steps: [],
          dataLossRisk: 'none',
          estimatedRollbackTime: 15,
        },
        riskMitigations: [],
      },
      ...overrides,
    };
  }

  describe('logMigrationStarted', () => {
    it('should record migration started event and execution', async () => {
      const execution = createMockExecution();

      await logger.logMigrationStarted(execution);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: execution.id,
          type: 'migration_started',
          userId: execution.securityContext.userId,
          environment: execution.securityContext.environment,
        })
      );
      expect(mockRepository.recordExecution).toHaveBeenCalledWith(execution);
    });

    it('should include preflight check details in event', async () => {
      const execution = createMockExecution();

      await logger.logMigrationStarted(execution);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            migrationFile: execution.migrationFile.filename,
            preflightChecks: expect.arrayContaining([
              expect.objectContaining({
                name: 'backup_check',
                status: 'passed',
              }),
            ]),
          }),
        })
      );
    });
  });

  describe('logMigrationCompleted', () => {
    it('should record migration completed event and update status', async () => {
      const executionId = 'exec-complete';
      const securityContext = createMockSecurityContext();

      await logger.logMigrationCompleted(executionId, securityContext);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: executionId,
          type: 'migration_completed',
          userId: securityContext.userId,
        })
      );
      expect(mockRepository.updateExecutionStatus).toHaveBeenCalledWith(executionId, 'completed');
    });

    it('should include additional details if provided', async () => {
      const executionId = 'exec-complete';
      const securityContext = createMockSecurityContext();
      const details = { rowsAffected: 100, duration: 45 };

      await logger.logMigrationCompleted(executionId, securityContext, details);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            rowsAffected: 100,
            duration: 45,
            completedAt: expect.any(String),
          }),
        })
      );
    });
  });

  describe('logMigrationFailed', () => {
    it('should record migration failed event and update status with error', async () => {
      const executionId = 'exec-failed';
      const error = new Error('Constraint violation');
      const securityContext = createMockSecurityContext();

      await logger.logMigrationFailed(executionId, error, securityContext);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: executionId,
          type: 'migration_failed',
          details: expect.objectContaining({
            error: error.message,
            stack: error.stack,
          }),
        })
      );
      expect(mockRepository.updateExecutionStatus).toHaveBeenCalledWith(
        executionId,
        'failed',
        error.message
      );
    });

    it('should include additional details if provided', async () => {
      const executionId = 'exec-failed';
      const error = new Error('Database error');
      const securityContext = createMockSecurityContext();
      const details = { query: 'SELECT * FROM users', lineNumber: 42 };

      await logger.logMigrationFailed(executionId, error, securityContext, details);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            query: 'SELECT * FROM users',
            lineNumber: 42,
          }),
        })
      );
    });
  });

  describe('logMigrationRolledBack', () => {
    it('should record migration rolled back event and update status', async () => {
      const executionId = 'exec-rollback';
      const securityContext = createMockSecurityContext();

      await logger.logMigrationRolledBack(executionId, securityContext);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: executionId,
          type: 'migration_rolled_back',
        })
      );
      expect(mockRepository.updateExecutionStatus).toHaveBeenCalledWith(
        executionId,
        'rolled_back'
      );
    });

    it('should include rollback details if provided', async () => {
      const executionId = 'exec-rollback';
      const securityContext = createMockSecurityContext();
      const details = { reason: 'Validation failed', automaticRollback: true };

      await logger.logMigrationRolledBack(executionId, securityContext, details);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            reason: 'Validation failed',
            automaticRollback: true,
          }),
        })
      );
    });
  });

  describe('logSecurityViolation', () => {
    it('should record security violation event', async () => {
      const executionId = 'exec-violation';
      const violation = 'Unauthorized migration attempt';
      const securityContext = createMockSecurityContext();

      await logger.logSecurityViolation(executionId, violation, securityContext);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          migrationId: executionId,
          type: 'security_violation',
          details: expect.objectContaining({
            violation,
            detectedAt: expect.any(String),
          }),
        })
      );
    });

    it('should include additional violation details if provided', async () => {
      const executionId = 'exec-violation';
      const violation = 'Role escalation attempt';
      const securityContext = createMockSecurityContext();
      const details = {
        attemptedRole: 'superadmin',
        actualRole: 'developer',
        severity: 'high',
      };

      await logger.logSecurityViolation(executionId, violation, securityContext, details);

      expect(mockRepository.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            violation,
            attemptedRole: 'superadmin',
            actualRole: 'developer',
            severity: 'high',
          }),
        })
      );
    });
  });
});

describe('createMigrationAuditRepository factory', () => {
  it('should return InMemoryRepository for development environment', () => {
    const repository = createMigrationAuditRepository(undefined, 'development');

    expect(repository).toBeInstanceOf(InMemoryMigrationAuditRepository);
  });

  it('should return DatabaseRepository for production with pool', () => {
    const mockPool = {} as Pool;
    const repository = createMigrationAuditRepository(mockPool, 'production');

    expect(repository).toBeInstanceOf(DatabaseMigrationAuditRepository);
  });

  it('should return InMemoryRepository for production without pool', () => {
    const repository = createMigrationAuditRepository(undefined, 'production');

    expect(repository).toBeInstanceOf(InMemoryMigrationAuditRepository);
  });

  it('should return injected repository if available', () => {
    const injectedRepository = new InMemoryMigrationAuditRepository();
    const mockPool = {
      __migrationAuditRepository: injectedRepository,
    } as any;

    const repository = createMigrationAuditRepository(mockPool, 'production');

    expect(repository).toBe(injectedRepository);
  });
});
