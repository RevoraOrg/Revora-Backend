import { Pool } from 'pg';
import {
  createMigrationAuditRepository,
  DatabaseMigrationAuditRepository,
  InMemoryMigrationAuditRepository,
  MigrationAuditLogger,
  MigrationAuditRepository,
} from './audit';
import {
  MigrationAuditEvent,
  MigrationExecution,
  MigrationSecurityContext,
} from './types';

const BASE_TIME = new Date('2026-03-01T12:00:00.000Z');

function makeSecurityContext(
  overrides: Partial<MigrationSecurityContext> = {},
): MigrationSecurityContext {
  return {
    userId: 'user-1',
    userRole: 'dba',
    sessionId: 'session-1',
    requestId: 'request-1',
    environment: 'staging',
    timestamp: BASE_TIME,
    ipAddress: '192.0.2.10',
    userAgent: 'jest',
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<MigrationAuditEvent> = {},
): MigrationAuditEvent {
  return {
    id: 'event-1',
    migrationId: 'migration-1',
    type: 'migration_started',
    userId: 'user-1',
    environment: 'staging',
    details: { filename: '001_create_table.sql' },
    securityContext: {
      userId: 'user-1',
      userRole: 'dba',
      sessionId: 'session-1',
      requestId: 'request-1',
      environment: 'staging',
      ipAddress: '192.0.2.10',
      userAgent: 'jest',
    },
    timestamp: BASE_TIME,
    ...overrides,
  };
}

function makeExecution(
  overrides: Partial<MigrationExecution> = {},
): MigrationExecution {
  return {
    id: 'migration-1',
    migrationFile: {
      filename: '001_create_table.sql',
      filepath: '/migrations/001_create_table.sql',
      content: 'CREATE TABLE example (id UUID PRIMARY KEY);',
      checksum: 'checksum-1',
      size: 42,
      riskLevel: 'low',
      requiresDowntime: false,
      requiresBackup: false,
      dependencies: [],
    },
    status: 'running',
    startedAt: BASE_TIME,
    rollbackAvailable: false,
    securityContext: makeSecurityContext(),
    preflightChecks: [],
    executionPlan: {
      steps: [],
      estimatedDuration: 10,
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
    ...overrides,
  };
}

describe('InMemoryMigrationAuditRepository', () => {
  let repository: InMemoryMigrationAuditRepository;

  beforeEach(() => {
    repository = new InMemoryMigrationAuditRepository();
  });

  it('filters audit events by migration, sorts newest first, and respects the limit', async () => {
    await repository.recordEvent(makeEvent({
      id: 'old',
      timestamp: new Date('2026-03-01T10:00:00.000Z'),
    }));
    await repository.recordEvent(makeEvent({
      id: 'other-migration',
      migrationId: 'migration-2',
      timestamp: new Date('2026-03-01T13:00:00.000Z'),
    }));
    await repository.recordEvent(makeEvent({
      id: 'new',
      timestamp: new Date('2026-03-01T11:00:00.000Z'),
    }));

    const events = await repository.getAuditEvents('migration-1', 1);

    expect(events.map(event => event.id)).toEqual(['new']);
  });

  it('filters violations inclusively from the since date, newest first, and respects the limit', async () => {
    const since = new Date('2026-03-01T10:00:00.000Z');
    await repository.recordEvent(makeEvent({
      id: 'before',
      type: 'security_violation',
      timestamp: new Date('2026-03-01T09:59:59.999Z'),
    }));
    await repository.recordEvent(makeEvent({
      id: 'at-boundary',
      type: 'security_violation',
      timestamp: since,
    }));
    await repository.recordEvent(makeEvent({
      id: 'newest',
      type: 'security_violation',
      timestamp: new Date('2026-03-01T12:00:00.000Z'),
    }));
    await repository.recordEvent(makeEvent({
      id: 'not-violation',
      type: 'migration_failed',
      timestamp: new Date('2026-03-01T13:00:00.000Z'),
    }));

    const violations = await repository.getSecurityViolations(since, 1);

    expect(violations.map(event => event.id)).toEqual(['newest']);
  });

  it('sorts execution history newest first and applies the limit', async () => {
    await repository.recordExecution(makeExecution({
      id: 'old',
      startedAt: new Date('2026-03-01T10:00:00.000Z'),
    }));
    await repository.recordExecution(makeExecution({
      id: 'new',
      startedAt: new Date('2026-03-01T11:00:00.000Z'),
    }));

    const executions = await repository.getExecutionHistory(1);

    expect(executions.map(execution => execution.id)).toEqual(['new']);
  });

  it('updates execution state and sets completion time only for terminal statuses', async () => {
    const execution = makeExecution();
    await repository.recordExecution(execution);

    await repository.updateExecutionStatus(execution.id, 'running');
    expect(execution.status).toBe('running');
    expect(execution.completedAt).toBeUndefined();

    await repository.updateExecutionStatus(execution.id, 'failed', 'checksum mismatch');

    expect(execution.status).toBe('failed');
    expect(execution.errorMessage).toBe('checksum mismatch');
    expect(execution.completedAt).toBeInstanceOf(Date);
  });

  it('leaves executions unchanged when updating an unknown id', async () => {
    await expect(
      repository.updateExecutionStatus('missing', 'completed'),
    ).resolves.toBeUndefined();
    expect(repository.getAllExecutions()).toEqual([]);
  });

  it('clears recorded events and executions', async () => {
    await repository.recordEvent(makeEvent());
    await repository.recordExecution(makeExecution());

    repository.clear();

    expect(repository.getAllEvents()).toEqual([]);
    expect(repository.getAllExecutions()).toEqual([]);
  });
});

describe('DatabaseMigrationAuditRepository', () => {
  let pool: { query: jest.Mock };
  let repository: DatabaseMigrationAuditRepository;

  beforeEach(() => {
    pool = { query: jest.fn() };
    repository = new DatabaseMigrationAuditRepository(pool as unknown as Pool);
  });

  it('inserts audit events with JSON fields serialized', async () => {
    const event = makeEvent();

    await repository.recordEvent(event);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO migration_audit_events'),
      [
        event.id,
        event.migrationId,
        event.type,
        event.userId,
        event.environment,
        JSON.stringify(event.details),
        JSON.stringify(event.securityContext),
        event.timestamp,
      ],
    );
  });

  it('inserts execution fields and serializes JSON columns', async () => {
    const execution = makeExecution();

    await repository.recordExecution(execution);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO migration_executions'),
      [
        execution.id,
        execution.migrationFile.filename,
        execution.migrationFile.filepath,
        execution.migrationFile.checksum,
        execution.status,
        execution.startedAt,
        null,
        null,
        execution.rollbackAvailable,
        JSON.stringify(execution.preflightChecks),
        JSON.stringify(execution.executionPlan),
        JSON.stringify(execution.securityContext),
        execution.migrationFile.riskLevel,
        execution.migrationFile.requiresDowntime,
        execution.migrationFile.requiresBackup,
      ],
    );
  });

  it('sets terminal execution status with an error and completion timestamp', async () => {
    await repository.updateExecutionStatus('migration-1', 'failed', 'migration error');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE migration_executions'),
      ['failed', 'migration error', expect.any(Date), 'migration-1'],
    );
  });

  it('leaves completion timestamp null for a non-terminal status', async () => {
    await repository.updateExecutionStatus('migration-1', 'running');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE migration_executions'),
      ['running', null, null, 'migration-1'],
    );
  });

  it('maps execution history rows, including JSON strings and timestamps', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 'migration-1',
        migration_filename: '001_create_table.sql',
        migration_filepath: '/migrations/001_create_table.sql',
        migration_checksum: 'checksum-1',
        status: 'completed',
        started_at: '2026-03-01T10:00:00.000Z',
        completed_at: '2026-03-01T10:01:00.000Z',
        error_message: null,
        rollback_available: true,
        preflight_checks: '[{"name":"schema","status":"passed","critical":true}]',
        execution_plan: '{"steps":[],"estimatedDuration":10}',
        security_context: '{"userId":"user-1"}',
        risk_level: 'low',
        requires_downtime: false,
        requires_backup: true,
      }],
    });

    const executions = await repository.getExecutionHistory(20);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY started_at DESC'),
      [20],
    );
    expect(executions[0]).toEqual(expect.objectContaining({
      id: 'migration-1',
      migrationFile: expect.objectContaining({
        filename: '001_create_table.sql',
        content: '',
        size: 0,
        dependencies: [],
        riskLevel: 'low',
        requiresBackup: true,
      }),
      status: 'completed',
      startedAt: new Date('2026-03-01T10:00:00.000Z'),
      completedAt: new Date('2026-03-01T10:01:00.000Z'),
      preflightChecks: [{ name: 'schema', status: 'passed', critical: true }],
      executionPlan: { steps: [], estimatedDuration: 10 },
      securityContext: { userId: 'user-1' },
    }));
  });

  it('queries audit events by execution and maps JSON objects and dates', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 'event-1',
        migration_id: 'migration-1',
        type: 'migration_completed',
        user_id: 'user-1',
        environment: 'staging',
        details: { changedTables: 2 },
        security_context: { userId: 'user-1' },
        timestamp: '2026-03-01T12:00:00.000Z',
      }],
    });

    const events = await repository.getAuditEvents('migration-1', 15);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE $1::text IS NULL OR migration_id = $1'),
      ['migration-1', 15],
    );
    expect(events[0]).toEqual(expect.objectContaining({
      id: 'event-1',
      migrationId: 'migration-1',
      details: { changedTables: 2 },
      securityContext: { userId: 'user-1' },
      timestamp: new Date('2026-03-01T12:00:00.000Z'),
    }));
  });

  it('queries unfiltered audit history when no execution id is supplied', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await repository.getAuditEvents();

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE $1::text IS NULL OR migration_id = $1'),
      [null, 100],
    );
  });

  it('queries security violations since a date and parses serialized event fields', async () => {
    const since = new Date('2026-03-01T10:00:00.000Z');
    pool.query.mockResolvedValue({
      rows: [{
        id: 'event-2',
        migration_id: 'migration-2',
        type: 'security_violation',
        user_id: 'user-2',
        environment: 'production',
        details: '{"violation":"unauthorized"}',
        security_context: '{"userId":"user-2"}',
        timestamp: '2026-03-01T11:00:00.000Z',
      }],
    });

    const events = await repository.getSecurityViolations(since, 5);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("type = 'security_violation' AND timestamp >= $1"),
      [since, 5],
    );
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'security_violation',
      details: { violation: 'unauthorized' },
      securityContext: { userId: 'user-2' },
      timestamp: new Date('2026-03-01T11:00:00.000Z'),
    }));
  });
});

describe('createMigrationAuditRepository', () => {
  it('uses the database repository in production when a pool is supplied', () => {
    const pool = { query: jest.fn() } as unknown as Pool;

    expect(createMigrationAuditRepository(pool, 'production'))
      .toBeInstanceOf(DatabaseMigrationAuditRepository);
  });

  it('uses the in-memory repository outside production', () => {
    const pool = { query: jest.fn() } as unknown as Pool;

    expect(createMigrationAuditRepository(pool, 'test'))
      .toBeInstanceOf(InMemoryMigrationAuditRepository);
  });

  it('uses the in-memory repository in production without a pool', () => {
    expect(createMigrationAuditRepository(undefined, 'production'))
      .toBeInstanceOf(InMemoryMigrationAuditRepository);
  });

  it('returns an injected repository before applying environment selection', () => {
    const injected = new InMemoryMigrationAuditRepository();
    const pool = {
      query: jest.fn(),
      __migrationAuditRepository: injected,
    } as unknown as Pool;

    expect(createMigrationAuditRepository(pool, 'production')).toBe(injected);
  });
});

describe('MigrationAuditLogger', () => {
  it('does not update execution status when recording the completion event fails', async () => {
    const failure = new Error('audit store unavailable');
    const repository: MigrationAuditRepository = {
      recordEvent: jest.fn(async (): Promise<void> => {
        throw failure;
      }),
      recordExecution: jest.fn(async (): Promise<void> => undefined),
      updateExecutionStatus: jest.fn(async (): Promise<void> => {}),
      getExecutionHistory: jest.fn(async () => []),
      getAuditEvents: jest.fn(async () => []),
      getSecurityViolations: jest.fn(async () => []),
    };
    const logger = new MigrationAuditLogger(repository);

    await expect(
      logger.logMigrationCompleted('migration-1', makeSecurityContext()),
    ).rejects.toBe(failure);
    expect(repository.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationId: 'migration-1',
        type: 'migration_completed',
      }),
    );
    expect(repository.updateExecutionStatus).not.toHaveBeenCalled();
  });
});
