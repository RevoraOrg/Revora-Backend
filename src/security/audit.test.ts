import {
  InMemorySecurityAuditRepository,
  DatabaseSecurityAuditRepository,
  SECURITY_AUDIT_EVENTS_SCHEMA,
  createSecurityAuditRepository,
} from './audit';
import { AuditEvent } from './types';

function createMockEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: overrides.id || `audit-${Math.random().toString(36).slice(2, 9)}`,
    type: overrides.type || 'AUTHENTICATION',
    userId: overrides.userId ?? 'user-123',
    sessionId: overrides.sessionId ?? 'session-abc',
    action: overrides.action || 'user.login',
    resource: overrides.resource || 'auth_service',
    outcome: overrides.outcome || 'SUCCESS',
    details: overrides.details || { method: 'password', ip: '127.0.0.1' },
    securityContext: overrides.securityContext || {
      requestId: 'req-001',
      ipAddress: '127.0.0.1',
      userAgent: 'JestTestRunner/1.0',
      timestamp: new Date('2026-10-08T08:00:00Z'),
    },
    timestamp: overrides.timestamp || new Date('2026-10-08T08:00:00Z'),
  };
}

describe('Security Audit Suite (Issue #1078)', () => {
  describe('InMemorySecurityAuditRepository', () => {
    let repo: InMemorySecurityAuditRepository;

    beforeEach(() => {
      repo = new InMemorySecurityAuditRepository();
    });

    it('records and retrieves events via getAllEvents and getEventCount', async () => {
      expect(repo.getEventCount()).toBe(0);
      expect(repo.getAllEvents()).toEqual([]);

      const event1 = createMockEvent({ id: 'evt-1', action: 'login' });
      const event2 = createMockEvent({ id: 'evt-2', action: 'logout' });

      await repo.record(event1);
      await repo.record(event2);

      expect(repo.getEventCount()).toBe(2);
      const all = repo.getAllEvents();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe('evt-1');
      expect(all[1].id).toBe('evt-2');
    });

    it('clears all recorded events cleanly', async () => {
      await repo.record(createMockEvent({ id: 'evt-1' }));
      expect(repo.getEventCount()).toBe(1);

      repo.clear();
      expect(repo.getEventCount()).toBe(0);
      expect(repo.getAllEvents()).toEqual([]);
    });

    it('filters by userId and orders chronologically descending', async () => {
      const t1 = new Date('2026-10-08T01:00:00Z');
      const t2 = new Date('2026-10-08T02:00:00Z');
      const t3 = new Date('2026-10-08T03:00:00Z');

      await repo.record(createMockEvent({ id: 'e1', userId: 'user-A', timestamp: t1 }));
      await repo.record(createMockEvent({ id: 'e2', userId: 'user-B', timestamp: t2 }));
      await repo.record(createMockEvent({ id: 'e3', userId: 'user-A', timestamp: t3 }));

      const userAEvents = await repo.findByUserId('user-A');
      expect(userAEvents).toHaveLength(2);
      expect(userAEvents[0].id).toBe('e3'); // Newer first
      expect(userAEvents[1].id).toBe('e1');

      const nonExistent = await repo.findByUserId('user-non-existent');
      expect(nonExistent).toEqual([]);
    });

    it('respects limit parameter on findByUserId', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.record(
          createMockEvent({
            id: `evt-${i}`,
            userId: 'user-limit',
            timestamp: new Date(2026, 9, 8, 1, i),
          })
        );
      }

      const limited = await repo.findByUserId('user-limit', 2);
      expect(limited).toHaveLength(2);
      expect(limited[0].id).toBe('evt-4');
      expect(limited[1].id).toBe('evt-3');
    });

    it('filters by sessionId and orders chronologically descending', async () => {
      const s1 = 'session-x';
      const s2 = 'session-y';

      await repo.record(createMockEvent({ id: 'e1', sessionId: s1, timestamp: new Date(1000) }));
      await repo.record(createMockEvent({ id: 'e2', sessionId: s2, timestamp: new Date(2000) }));
      await repo.record(createMockEvent({ id: 'e3', sessionId: s1, timestamp: new Date(3000) }));

      const results = await repo.findBySessionId(s1, 10);
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('e3');
      expect(results[1].id).toBe('e1');
    });

    it('filters security violations since given timestamp and orders descending', async () => {
      const cutoff = new Date('2026-10-08T12:00:00Z');
      const beforeCutoff = new Date('2026-10-08T10:00:00Z');
      const afterCutoff1 = new Date('2026-10-08T13:00:00Z');
      const afterCutoff2 = new Date('2026-10-08T14:00:00Z');

      // 1: Violation before cutoff -> excluded
      await repo.record(
        createMockEvent({
          id: 'v-old',
          type: 'SECURITY_VIOLATION',
          timestamp: beforeCutoff,
        })
      );

      // 2: Non-violation after cutoff -> excluded
      await repo.record(
        createMockEvent({
          id: 'auth-valid',
          type: 'AUTHENTICATION',
          timestamp: afterCutoff1,
        })
      );

      // 3: Violations after cutoff -> included
      await repo.record(
        createMockEvent({
          id: 'v-1',
          type: 'SECURITY_VIOLATION',
          timestamp: afterCutoff1,
        })
      );
      await repo.record(
        createMockEvent({
          id: 'v-2',
          type: 'SECURITY_VIOLATION',
          timestamp: afterCutoff2,
        })
      );

      const violations = await repo.findSecurityViolations(cutoff);
      expect(violations).toHaveLength(2);
      expect(violations[0].id).toBe('v-2');
      expect(violations[1].id).toBe('v-1');
    });

    it('prunes stored events buffer when exceeding maxEvents threshold', async () => {
      // Access private maxEvents by casting or filling
      const customRepo = new InMemorySecurityAuditRepository();
      // Set private maxEvents lower for quick test verification
      (customRepo as any).maxEvents = 10;

      for (let i = 0; i < 15; i++) {
        await customRepo.record(
          createMockEvent({
            id: `fill-${i}`,
            timestamp: new Date(1000 + i * 100),
          })
        );
      }

      // 10 * 0.8 = 8 items kept after overflow + remaining
      expect(customRepo.getEventCount()).toBeLessThanOrEqual(12);
      const events = customRepo.getAllEvents();
      // Most recent items should be preserved
      expect(events[events.length - 1].id).toBe('fill-14');
    });
  });

  describe('DatabaseSecurityAuditRepository', () => {
    let mockPool: { query: jest.Mock };
    let repo: DatabaseSecurityAuditRepository;

    beforeEach(() => {
      mockPool = { query: jest.fn() };
      repo = new DatabaseSecurityAuditRepository(mockPool);
    });

    it('records event into postgres table with serialized JSON fields', async () => {
      const event = createMockEvent({
        id: 'db-evt-1',
        details: { reason: 'invalid_token' },
        securityContext: {
          requestId: 'req-42',
          ipAddress: '10.0.0.1',
          userAgent: 'TestClient',
          timestamp: new Date('2026-10-08T10:00:00Z'),
        },
      });

      mockPool.query.mockResolvedValueOnce({ rowCount: 1 });

      await repo.record(event);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO security_audit_events');
      expect(params[0]).toBe('db-evt-1');
      expect(params[1]).toBe(event.type);
      expect(params[2]).toBe(event.userId);
      expect(params[3]).toBe(event.sessionId);
      expect(params[4]).toBe(event.action);
      expect(params[5]).toBe(event.resource);
      expect(params[6]).toBe(event.outcome);
      expect(params[7]).toBe(JSON.stringify(event.details));
      expect(params[8]).toBe(JSON.stringify(event.securityContext));
      expect(params[9]).toBe(event.timestamp);
    });

    it('queries and maps rows in findByUserId', async () => {
      const row = {
        id: 'row-1',
        type: 'AUTHENTICATION',
        user_id: 'u-1',
        session_id: 's-1',
        action: 'login',
        resource: 'auth',
        outcome: 'SUCCESS',
        details: JSON.stringify({ ip: '1.2.3.4' }),
        security_context: JSON.stringify({ requestId: 'r-1' }),
        timestamp: '2026-10-08T09:00:00.000Z',
      };

      mockPool.query.mockResolvedValueOnce({ rows: [row] });

      const results = await repo.findByUserId('u-1', 25);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE user_id = $1'),
        ['u-1', 25]
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('row-1');
      expect(results[0].userId).toBe('u-1');
      expect(results[0].details).toEqual({ ip: '1.2.3.4' });
      expect(results[0].securityContext).toEqual({ requestId: 'r-1' });
      expect(results[0].timestamp).toBeInstanceOf(Date);
    });

    it('queries and maps rows in findBySessionId', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const results = await repo.findBySessionId('sess-100', 50);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE session_id = $1'),
        ['sess-100', 50]
      );
      expect(results).toEqual([]);
    });

    it('queries and maps rows in findSecurityViolations', async () => {
      const sinceDate = new Date('2026-10-08T00:00:00Z');
      const row = {
        id: 'viol-1',
        type: 'SECURITY_VIOLATION',
        user_id: 'u-viol',
        session_id: 's-viol',
        action: 'privilege_escalation',
        resource: 'admin_panel',
        outcome: 'BLOCKED',
        details: { attempt: 3 }, // Already parsed object
        security_context: { requestId: 'r-v' }, // Already parsed object
        timestamp: new Date('2026-10-08T05:00:00Z'),
      };

      mockPool.query.mockResolvedValueOnce({ rows: [row] });

      const results = await repo.findSecurityViolations(sinceDate, 10);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining("type = 'SECURITY_VIOLATION' AND timestamp >= $1"),
        [sinceDate, 10]
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('viol-1');
      expect(results[0].outcome).toBe('BLOCKED');
    });
  });

  describe('SECURITY_AUDIT_EVENTS_SCHEMA', () => {
    it('defines security_audit_events table with strict enum constraints and indexes', () => {
      expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS security_audit_events');
      expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('CHECK (type IN');
      expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('CHECK (outcome IN');
      expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_user_id');
      expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_security_violations');
    });
  });

  describe('createSecurityAuditRepository factory', () => {
    it('returns InMemorySecurityAuditRepository when pool is omitted or not production', () => {
      const inMem = createSecurityAuditRepository(undefined, 'development');
      expect(inMem).toBeInstanceOf(InMemorySecurityAuditRepository);

      const testRepo = createSecurityAuditRepository({ query: jest.fn() }, 'test');
      expect(testRepo).toBeInstanceOf(InMemorySecurityAuditRepository);
    });

    it('returns DatabaseSecurityAuditRepository when production with valid pool', () => {
      const mockPool = { query: jest.fn() };
      const prodRepo = createSecurityAuditRepository(mockPool, 'production');
      expect(prodRepo).toBeInstanceOf(DatabaseSecurityAuditRepository);
    });
  });
});
