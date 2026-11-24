import {
  AuditLogSecurityAuditRepository,
  createSecurityAuditRepository,
  DatabaseSecurityAuditRepository,
  InMemorySecurityAuditRepository,
} from './audit';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { AuditEvent } from './types';

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'event-1',
    type: 'AUTHENTICATION',
    userId: 'user-1',
    sessionId: 'session-1',
    action: 'login',
    resource: 'auth',
    outcome: 'SUCCESS',
    details: { source: 'test' },
    securityContext: {
      requestId: 'request-1',
      ipAddress: '192.0.2.10',
      userAgent: 'jest',
      timestamp: new Date('2026-01-15T10:00:00.000Z'),
    },
    timestamp: new Date('2026-01-15T10:00:00.000Z'),
    ...overrides,
  };
}

describe('InMemorySecurityAuditRepository', () => {
  let repository: InMemorySecurityAuditRepository;

  beforeEach(() => {
    repository = new InMemorySecurityAuditRepository();
  });

  it('records and exposes events', async () => {
    const event = makeEvent();

    await repository.record(event);

    expect(repository.getEventCount()).toBe(1);
    expect(repository.getAllEvents()).toEqual([event]);
  });

  it('returns defensive copies from getAllEvents', async () => {
    await repository.record(makeEvent());

    const events = repository.getAllEvents();
    events.length = 0;

    expect(repository.getEventCount()).toBe(1);
  });

  it('filters by user id, sorts newest first, and applies the limit', async () => {
    await repository.record(makeEvent({
      id: 'old',
      timestamp: new Date('2026-01-15T09:00:00.000Z'),
    }));
    await repository.record(makeEvent({
      id: 'new',
      timestamp: new Date('2026-01-15T11:00:00.000Z'),
    }));
    await repository.record(makeEvent({
      id: 'other-user',
      userId: 'user-2',
      timestamp: new Date('2026-01-15T12:00:00.000Z'),
    }));

    const events = await repository.findByUserId('user-1', 1);

    expect(events.map(event => event.id)).toEqual(['new']);
  });

  it('filters by session id and uses the default limit', async () => {
    await repository.record(makeEvent({ id: 'first', sessionId: 'session-1' }));
    await repository.record(makeEvent({ id: 'second', sessionId: 'session-2' }));

    const events = await repository.findBySessionId('session-1');

    expect(events.map(event => event.id)).toEqual(['first']);
  });

  it('finds security violations since a timestamp and applies the limit', async () => {
    await repository.record(makeEvent({
      id: 'old',
      type: 'SECURITY_VIOLATION',
      timestamp: new Date('2026-01-14T10:00:00.000Z'),
    }));
    await repository.record(makeEvent({
      id: 'new',
      type: 'SECURITY_VIOLATION',
      timestamp: new Date('2026-01-15T12:00:00.000Z'),
    }));
    await repository.record(makeEvent({
      id: 'allowed',
      type: 'AUTHORIZATION',
      timestamp: new Date('2026-01-15T13:00:00.000Z'),
    }));

    const events = await repository.findSecurityViolations(
      new Date('2026-01-15T00:00:00.000Z'),
      1,
    );

    expect(events.map(event => event.id)).toEqual(['new']);
  });

  it('clears all stored events', async () => {
    await repository.record(makeEvent());

    repository.clear();

    expect(repository.getEventCount()).toBe(0);
    expect(repository.getAllEvents()).toEqual([]);
  });

  it('bounds memory by retaining 80 percent after exceeding 10,000 events', async () => {
    for (let i = 0; i <= 10_000; i++) {
      await repository.record(makeEvent({ id: `event-${i}` }));
    }

    expect(repository.getEventCount()).toBe(8000);
  });
});

describe('AuditLogSecurityAuditRepository', () => {
  let auditLogRepo: {
    createAuditLog: jest.Mock;
    getAuditLogsByUser: jest.Mock;
    getAuditLogsByAction: jest.Mock;
  };
  let repository: AuditLogSecurityAuditRepository;

  beforeEach(() => {
    auditLogRepo = {
      createAuditLog: jest.fn(),
      getAuditLogsByUser: jest.fn(),
      getAuditLogsByAction: jest.fn(),
    };
    repository = new AuditLogSecurityAuditRepository(
      auditLogRepo as unknown as AuditLogRepository,
    );
  });

  it('maps a security event onto the audit-log input fields', async () => {
    const event = makeEvent();

    await repository.record(event);

    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith({
      user_id: 'user-1',
      action: 'login',
      resource: 'auth',
      details: JSON.stringify(event.details),
      ip_address: '192.0.2.10',
      user_agent: JSON.stringify({
        requestId: 'request-1',
        userAgent: 'jest',
        timestamp: event.securityContext.timestamp,
      }),
    });
  });

  it('stores null user id and serializes details for anonymous events', async () => {
    await repository.record(makeEvent({ userId: undefined }));

    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: null }),
    );
  });

  it('maps audit-log rows returned for a user', async () => {
    const timestamp = new Date('2026-01-15T10:00:00.000Z');
    auditLogRepo.getAuditLogsByUser.mockResolvedValue([
      {
        id: 'log-1',
        user_id: 'user-1',
        action: 'auth_login',
        resource: 'auth',
        details: '{"provider":"test"}',
        ip_address: '192.0.2.10',
        user_agent: '{"requestId":"request-1","userAgent":"jest"}',
        created_at: timestamp,
      },
    ]);

    const events = await repository.findByUserId('user-1', 25);

    expect(auditLogRepo.getAuditLogsByUser).toHaveBeenCalledWith('user-1', 25);
    expect(events).toEqual([
      expect.objectContaining({
        id: 'log-1',
        type: 'AUTHENTICATION',
        userId: 'user-1',
        sessionId: undefined,
        action: 'auth_login',
        resource: 'auth',
        outcome: 'SUCCESS',
        details: { provider: 'test' },
        securityContext: {
          ipAddress: '192.0.2.10',
          requestId: 'request-1',
          userAgent: 'jest',
          timestamp,
        },
        timestamp,
      }),
    ]);
  });

  it('uses safe fallbacks for malformed audit-log JSON fields', async () => {
    const timestamp = new Date('2026-01-15T10:00:00.000Z');
    auditLogRepo.getAuditLogsByUser.mockResolvedValue([
      {
        id: 'log-2',
        user_id: null,
        action: 'violation detected',
        resource: null,
        details: '{malformed',
        ip_address: null,
        user_agent: '{malformed',
        created_at: timestamp,
      },
    ]);

    const events = await repository.findByUserId('user-1');

    expect(events[0]).toEqual(expect.objectContaining({
      type: 'SECURITY_VIOLATION',
      userId: undefined,
      resource: '',
      details: {},
      securityContext: {
        ipAddress: null,
        requestId: 'unknown',
        userAgent: 'unknown',
        timestamp,
      },
    }));
  });

  it('does not expose session ids because the audit-log schema does not store them', async () => {
    await expect(repository.findBySessionId('session-1')).resolves.toEqual([]);
  });

  it('filters security violations by AML action and timestamp', async () => {
    const recent = new Date('2026-01-15T10:00:00.000Z');
    const old = new Date('2026-01-14T10:00:00.000Z');
    auditLogRepo.getAuditLogsByAction.mockResolvedValue([
      {
        id: 'recent',
        action: 'aml_alert_created',
        created_at: recent,
        details: { type: 'object' },
      },
      {
        id: 'old',
        action: 'aml_alert_created',
        created_at: old,
        details: null,
      },
    ]);

    const events = await repository.findSecurityViolations(
      new Date('2026-01-15T00:00:00.000Z'),
      10,
    );

    expect(auditLogRepo.getAuditLogsByAction).toHaveBeenCalledWith('aml_', 10);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('recent');
  });

  it('infers validation as the default audit-log event type', async () => {
    auditLogRepo.getAuditLogsByUser.mockResolvedValue([
      {
        id: 'log-3',
        action: 'kyc_review',
        created_at: new Date('2026-01-15T10:00:00.000Z'),
        details: null,
      },
    ]);

    const events = await repository.findByUserId('user-1');

    expect(events[0].type).toBe('VALIDATION');
  });
});

describe('DatabaseSecurityAuditRepository', () => {
  let pool: { query: jest.Mock };
  let repository: DatabaseSecurityAuditRepository;

  beforeEach(() => {
    pool = { query: jest.fn() };
    repository = new DatabaseSecurityAuditRepository(pool);
  });

  it('writes every audit event field as SQL parameters', async () => {
    const event = makeEvent();

    await repository.record(event);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO security_audit_events'),
      [
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
      ],
    );
  });

  it('queries and maps events by user id', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 'event-1',
        type: 'AUTHENTICATION',
        user_id: 'user-1',
        session_id: 'session-1',
        action: 'login',
        resource: 'auth',
        outcome: 'SUCCESS',
        details: '{"source":"test"}',
        security_context: '{"ipAddress":"192.0.2.10"}',
        timestamp: '2026-01-15T10:00:00.000Z',
      }],
    });

    const events = await repository.findByUserId('user-1', 25);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE user_id = $1'),
      ['user-1', 25],
    );
    expect(events[0]).toEqual(expect.objectContaining({
      id: 'event-1',
      details: { source: 'test' },
      securityContext: { ipAddress: '192.0.2.10' },
      timestamp: new Date('2026-01-15T10:00:00.000Z'),
    }));
  });

  it('queries and maps events by session id', async () => {
    pool.query.mockResolvedValue({
      rows: [{
        id: 'event-2',
        type: 'AUTHORIZATION',
        user_id: 'user-1',
        session_id: 'session-1',
        action: 'milestone_validate',
        resource: 'milestone-1',
        outcome: 'SUCCESS',
        details: { scope: 'validation' },
        security_context: { requestId: 'request-1' },
        timestamp: new Date('2026-01-15T10:00:00.000Z'),
      }],
    });

    const events = await repository.findBySessionId('session-1', 5);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE session_id = $1'),
      ['session-1', 5],
    );
    expect(events[0].sessionId).toBe('session-1');
  });

  it('queries security violations since the supplied timestamp', async () => {
    const since = new Date('2026-01-15T00:00:00.000Z');
    pool.query.mockResolvedValue({
      rows: [{
        id: 'event-3',
        type: 'SECURITY_VIOLATION',
        user_id: 'user-1',
        session_id: 'session-1',
        action: 'blocked_request',
        resource: 'api',
        outcome: 'BLOCKED',
        details: {},
        security_context: {},
        timestamp: '2026-01-15T11:00:00.000Z',
      }],
    });

    const events = await repository.findSecurityViolations(since, 15);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("type = 'SECURITY_VIOLATION'"),
      [since, 15],
    );
    expect(events[0].type).toBe('SECURITY_VIOLATION');
  });
});

describe('createSecurityAuditRepository', () => {
  it('creates a database repository for production with a pool', () => {
    const pool = { query: jest.fn() };

    expect(createSecurityAuditRepository(pool, 'production'))
      .toBeInstanceOf(DatabaseSecurityAuditRepository);
  });

  it('creates an in-memory repository for production without a pool', () => {
    expect(createSecurityAuditRepository(undefined, 'production'))
      .toBeInstanceOf(InMemorySecurityAuditRepository);
  });

  it('creates an in-memory repository outside production even with a pool', () => {
    const pool = { query: jest.fn() };

    expect(createSecurityAuditRepository(pool, 'test'))
      .toBeInstanceOf(InMemorySecurityAuditRepository);
  });
});
