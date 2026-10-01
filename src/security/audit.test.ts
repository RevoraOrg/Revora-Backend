/**
 * @fileoverview Focused behavior coverage for `src/security/audit.ts` (issue #1078).
 *
 * Protects the public contract of:
 * - {@link InMemorySecurityAuditRepository} (initial state, record/retrieve,
 *   ordering, limits, security-violation filtering, clear/re-populate
 *   transitions, instance isolation, capacity-eviction boundary);
 * - {@link DatabaseSecurityAuditRepository} (SQL + parameter contract through
 *   the injected pool, row mapping, empty results, error propagation) — the
 *   pool is mocked following the repository's established testing pattern;
 * - {@link SECURITY_AUDIT_EVENTS_SCHEMA} (the exported SQL DDL string);
 * - `createSecurityAuditRepository` (environment/pool selection) and the
 *   module's hash-chain / integrity-scheduler re-export surface.
 *
 * All fixtures are deterministic: fixed identifiers and fixed timestamps, no
 * wall-clock reads, sleeps, or cross-test state.
 *
 * @module security/audit.test
 */

import {
  createSecurityAuditRepository,
  DatabaseSecurityAuditRepository,
  InMemorySecurityAuditRepository,
  SECURITY_AUDIT_EVENTS_SCHEMA,
} from './audit';
import type { AuditEvent } from './types';
import * as auditModule from './audit';
import * as hashChainModule from './auditHashChain';
import * as schedulerModule from './auditIntegrityScheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed instant used for every fixture timestamp (never `new Date()`). */
const BASE_TIME = new Date('2026-01-15T10:00:00.000Z');

/** ISO text for {@link BASE_TIME}, matching what a pg row would carry. */
const BASE_TIME_ISO = '2026-01-15T10:00:00.000Z';

/** Build the securityContext payload required by `AuditEvent`. */
function securityContextAt(timestamp: Date = BASE_TIME) {
  return {
    requestId: 'req-1',
    ipAddress: '203.0.113.7',
    userAgent: 'jest-test-agent/1.0',
    timestamp,
  };
}

/** Build a valid `AuditEvent` with deterministic defaults. */
function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    type: 'AUTHENTICATION',
    userId: 'user-1',
    sessionId: 'session-1',
    action: 'login',
    resource: 'session',
    outcome: 'SUCCESS',
    details: { method: 'password' },
    securityContext: securityContextAt(),
    timestamp: BASE_TIME,
    ...overrides,
  };
}

/**
 * Build a raw database row as the pg driver would return it from
 * `security_audit_events` (snake_case columns, JSONB as text by default).
 */
function makeDbRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-1',
    type: 'AUTHENTICATION',
    user_id: 'user-1',
    session_id: 'session-1',
    action: 'login',
    resource: 'session',
    outcome: 'SUCCESS',
    details: JSON.stringify({ method: 'password' }),
    security_context: JSON.stringify({
      requestId: 'req-1',
      ipAddress: '203.0.113.7',
      userAgent: 'jest-test-agent/1.0',
      timestamp: BASE_TIME_ISO,
    }),
    timestamp: BASE_TIME_ISO,
    ...overrides,
  };
}

/** Minimal pool test double — the repository only ever calls `query`. */
function makePool(): { query: jest.Mock } {
  return { query: jest.fn() };
}

// ---------------------------------------------------------------------------
// InMemorySecurityAuditRepository
// ---------------------------------------------------------------------------

describe('InMemorySecurityAuditRepository', () => {
  let repo: InMemorySecurityAuditRepository;

  beforeEach(() => {
    repo = new InMemorySecurityAuditRepository();
  });

  describe('initial state', () => {
    it('starts empty', () => {
      expect(repo.getEventCount()).toBe(0);
      expect(repo.getAllEvents()).toEqual([]);
    });

    it('returns empty arrays from every finder before any events are recorded', async () => {
      await expect(repo.findByUserId('user-1')).resolves.toEqual([]);
      await expect(repo.findBySessionId('session-1')).resolves.toEqual([]);
      await expect(repo.findSecurityViolations(BASE_TIME)).resolves.toEqual([]);
    });
  });

  describe('record – success path', () => {
    it('resolves without a result value', async () => {
      await expect(repo.record(makeAuditEvent())).resolves.toBeUndefined();
    });

    it('persists the event so it becomes observable', async () => {
      const event = makeAuditEvent();

      await repo.record(event);

      expect(repo.getEventCount()).toBe(1);
      expect(repo.getAllEvents()).toEqual([event]);
    });

    it('keeps all fields intact through record → retrieve', async () => {
      const event = makeAuditEvent({
        type: 'SECURITY_VIOLATION',
        outcome: 'BLOCKED',
        action: 'milestone.validate',
        resource: 'vault:vault-1',
        details: { reason: 'signature mismatch' },
        securityContext: securityContextAt(new Date('2026-01-15T11:30:00.000Z')),
        timestamp: new Date('2026-01-15T11:30:00.000Z'),
      });

      await repo.record(event);

      const found = await repo.findByUserId('user-1');
      expect(found).toEqual([event]);
      expect(found[0]).toBe(event);
    });
  });

  describe('multiple events', () => {
    it('retains every event without overwriting previous ones', async () => {
      const events = [
        makeAuditEvent({ id: 'evt-1' }),
        makeAuditEvent({ id: 'evt-2' }),
        makeAuditEvent({ id: 'evt-3' }),
      ];

      for (const event of events) {
        await repo.record(event);
      }

      expect(repo.getEventCount()).toBe(3);
      expect(repo.getAllEvents().map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    });

    it('returns only the requested user’s events from findByUserId', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1', userId: 'user-1' }));
      await repo.record(makeAuditEvent({ id: 'evt-2', userId: 'user-2' }));
      await repo.record(makeAuditEvent({ id: 'evt-3', userId: 'user-1' }));

      const found = await repo.findByUserId('user-1');
      expect(found.map((e) => e.id).sort()).toEqual(['evt-1', 'evt-3']);
    });

    it('returns only the requested session’s events from findBySessionId', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1', sessionId: 'session-1' }));
      await repo.record(makeAuditEvent({ id: 'evt-2', sessionId: 'session-2' }));
      await repo.record(makeAuditEvent({ id: 'evt-3', sessionId: 'session-1' }));

      const found = await repo.findBySessionId('session-1');
      expect(found.map((e) => e.id).sort()).toEqual(['evt-1', 'evt-3']);
    });
  });

  describe('retrieval ordering and limits', () => {
    it('sorts results by timestamp descending regardless of insertion order', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-a', timestamp: new Date('2026-01-15T10:00:00.000Z') }));
      await repo.record(makeAuditEvent({ id: 'evt-b', timestamp: new Date('2026-01-15T10:02:00.000Z') }));
      await repo.record(makeAuditEvent({ id: 'evt-c', timestamp: new Date('2026-01-15T10:01:00.000Z') }));

      const found = await repo.findByUserId('user-1');
      expect(found.map((e) => e.id)).toEqual(['evt-b', 'evt-c', 'evt-a']);
    });

    it('applies an explicit limit to the newest events', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-a', timestamp: new Date('2026-01-15T10:00:00.000Z') }));
      await repo.record(makeAuditEvent({ id: 'evt-b', timestamp: new Date('2026-01-15T10:02:00.000Z') }));
      await repo.record(makeAuditEvent({ id: 'evt-c', timestamp: new Date('2026-01-15T10:01:00.000Z') }));

      const found = await repo.findByUserId('user-1', 2);
      expect(found.map((e) => e.id)).toEqual(['evt-b', 'evt-c']);
    });

    it('defaults the limit to 100 and keeps the newest events', async () => {
      for (let i = 0; i < 110; i++) {
        await repo.record(
          makeAuditEvent({
            id: `bulk-${String(i).padStart(3, '0')}`,
            timestamp: new Date(BASE_TIME.getTime() + i),
          }),
        );
      }

      const found = await repo.findByUserId('user-1');
      expect(found).toHaveLength(100);
      expect(found[0].id).toBe('bulk-109');
      expect(found[found.length - 1].id).toBe('bulk-010');
    });

    it('returns an empty array when the limit is 0', async () => {
      await repo.record(makeAuditEvent());

      await expect(repo.findByUserId('user-1', 0)).resolves.toEqual([]);
    });

    it('returns everything when the limit exceeds the match count', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1' }));
      await repo.record(makeAuditEvent({ id: 'evt-2' }));

      await expect(repo.findByUserId('user-1', 500)).resolves.toHaveLength(2);
    });
  });

  describe('findSecurityViolations', () => {
    it('returns only SECURITY_VIOLATION events', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-auth', type: 'AUTHENTICATION' }));
      await repo.record(
        makeAuditEvent({ id: 'evt-violation', type: 'SECURITY_VIOLATION', outcome: 'BLOCKED' }),
      );
      await repo.record(makeAuditEvent({ id: 'evt-validation', type: 'VALIDATION' }));

      const found = await repo.findSecurityViolations(new Date(0));
      expect(found.map((e) => e.id)).toEqual(['evt-violation']);
    });

    it('excludes violations older than the requested instant', async () => {
      const since = new Date('2026-01-15T10:05:00.000Z');
      await repo.record(
        makeAuditEvent({ id: 'evt-old', type: 'SECURITY_VIOLATION', timestamp: new Date('2026-01-15T10:04:59.999Z') }),
      );
      await repo.record(
        makeAuditEvent({ id: 'evt-new', type: 'SECURITY_VIOLATION', timestamp: new Date('2026-01-15T10:05:00.001Z') }),
      );

      const found = await repo.findSecurityViolations(since);
      expect(found.map((e) => e.id)).toEqual(['evt-new']);
    });

    it('includes violations exactly at the requested instant (inclusive boundary)', async () => {
      const at = new Date('2026-01-15T10:05:00.000Z');
      await repo.record(makeAuditEvent({ id: 'evt-edge', type: 'SECURITY_VIOLATION', timestamp: at }));

      const found = await repo.findSecurityViolations(at);
      expect(found.map((e) => e.id)).toEqual(['evt-edge']);
    });

    it('sorts violations newest-first and honors the limit', async () => {
      const at = (offset: number) => new Date(BASE_TIME.getTime() + offset);
      await repo.record(makeAuditEvent({ id: 'v-1', type: 'SECURITY_VIOLATION', timestamp: at(0) }));
      await repo.record(makeAuditEvent({ id: 'v-2', type: 'SECURITY_VIOLATION', timestamp: at(2000) }));
      await repo.record(makeAuditEvent({ id: 'v-3', type: 'SECURITY_VIOLATION', timestamp: at(1000) }));

      expect((await repo.findSecurityViolations(new Date(0))).map((e) => e.id)).toEqual([
        'v-2',
        'v-3',
        'v-1',
      ]);
      expect((await repo.findSecurityViolations(new Date(0), 2)).map((e) => e.id)).toEqual([
        'v-2',
        'v-3',
      ]);
    });
  });

  describe('state transitions', () => {
    it('empty → recorded: the first record transitions the store from empty to populated', async () => {
      expect(repo.getEventCount()).toBe(0);

      const event = makeAuditEvent({ id: 'evt-1' });
      await repo.record(event);

      expect(repo.getEventCount()).toBe(1);
      await expect(repo.findByUserId('user-1')).resolves.toEqual([event]);
    });

    it('populated → cleared: clear() returns the store to its initial state', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1' }));
      await repo.record(makeAuditEvent({ id: 'evt-2' }));

      repo.clear();

      expect(repo.getEventCount()).toBe(0);
      expect(repo.getAllEvents()).toEqual([]);
      await expect(repo.findByUserId('user-1')).resolves.toEqual([]);
      await expect(repo.findBySessionId('session-1')).resolves.toEqual([]);
    });

    it('cleared → re-populated: the store accepts new events after clear()', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1' }));
      repo.clear();

      const next = makeAuditEvent({ id: 'evt-3' });
      await repo.record(next);

      expect(repo.getEventCount()).toBe(1);
      expect(repo.getAllEvents()).toEqual([next]);
      await expect(repo.findByUserId('user-1')).resolves.toEqual([next]);
    });

    it('recorded → re-recorded: duplicate records are retained without de-duplication', async () => {
      const duplicate = makeAuditEvent({ id: 'evt-dup' });

      await repo.record(duplicate);
      await repo.record(duplicate);

      expect(repo.getEventCount()).toBe(2);
      const found = await repo.findByUserId('user-1');
      expect(found).toHaveLength(2);
      expect(found.every((e) => e.id === 'evt-dup')).toBe(true);
    });
  });

  describe('invalid inputs and failure behavior', () => {
    it('returns [] (not null or undefined) for an unknown userId and does not throw', async () => {
      await expect(repo.findByUserId('no-such-user')).resolves.toEqual([]);
    });

    it('returns [] for an unknown sessionId and does not throw', async () => {
      await expect(repo.findBySessionId('no-such-session')).resolves.toEqual([]);
    });

    it('returns [] when findSecurityViolations is given an instant in the future', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1', type: 'SECURITY_VIOLATION' }));

      await expect(
        repo.findSecurityViolations(new Date('2027-01-01T00:00:00.000Z')),
      ).resolves.toEqual([]);
    });

    it('never matches findByUserId for events recorded without a userId', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-anon', userId: undefined }));

      expect(repo.getEventCount()).toBe(1);
      await expect(repo.findByUserId('user-1')).resolves.toEqual([]);
    });

    it('does not perform runtime validation and stores the event verbatim (current contract)', async () => {
      // The in-memory repository is a passthrough store: record() neither
      // throws nor rejects for values TypeScript would reject at compile time.
      const malformed = makeAuditEvent({ id: 'evt-malformed', action: '' });

      await expect(repo.record(malformed)).resolves.toBeUndefined();
      expect(repo.getEventCount()).toBe(1);
      expect(repo.getAllEvents()[0].action).toBe('');
    });
  });

  describe('state integrity after failed/empty lookups', () => {
    it('leaves stored state intact when every lookup matches nothing', async () => {
      const first = makeAuditEvent({ id: 'evt-1' });
      const second = makeAuditEvent({ id: 'evt-2', userId: 'user-2', sessionId: 'session-2' });
      await repo.record(first);
      await repo.record(second);

      await repo.findByUserId('no-such-user');
      await repo.findBySessionId('no-such-session');
      await repo.findSecurityViolations(new Date('2027-01-01T00:00:00.000Z'));

      expect(repo.getEventCount()).toBe(2);
      expect(repo.getAllEvents()).toEqual([first, second]);
    });
  });

  describe('instance isolation', () => {
    it('does not share events between separate instances', async () => {
      const repoA = new InMemorySecurityAuditRepository();
      const repoB = new InMemorySecurityAuditRepository();

      const eventA = makeAuditEvent({ id: 'evt-a' });
      await repoA.record(eventA);

      expect(repoB.getEventCount()).toBe(0);
      await expect(repoB.findByUserId('user-1')).resolves.toEqual([]);

      // Recording into B does not leak back into A either.
      await repoB.record(makeAuditEvent({ id: 'evt-b' }));
      expect(repoA.getEventCount()).toBe(1);
      expect(repoA.getAllEvents().map((e) => e.id)).toEqual(['evt-a']);
    });
  });

  describe('encapsulation', () => {
    it('getAllEvents returns a defensive copy', async () => {
      await repo.record(makeAuditEvent({ id: 'evt-1' }));

      const snapshot = repo.getAllEvents();
      snapshot.length = 0;

      expect(repo.getEventCount()).toBe(1);
      expect(repo.getAllEvents()).toHaveLength(1);
    });
  });

  describe('capacity boundary (eviction)', () => {
    it('keeps events untrimmed while at the maximum capacity', async () => {
      for (let i = 0; i < 10000; i++) {
        await repo.record(
          makeAuditEvent({
            id: `cap-${i}`,
            timestamp: new Date(BASE_TIME.getTime() + i),
          }),
        );
      }

      expect(repo.getEventCount()).toBe(10000);
    });

    it('trims to 80% of the cap once exceeded and keeps the newest events', async () => {
      for (let i = 0; i <= 10000; i++) {
        await repo.record(
          makeAuditEvent({
            id: `cap-${i}`,
            timestamp: new Date(BASE_TIME.getTime() + i),
          }),
        );
      }

      // 10001st record triggers eviction down to 80% of 10000.
      expect(repo.getEventCount()).toBe(8000);

      const retained = repo.getAllEvents();
      expect(retained[0].id).toBe('cap-2001');
      expect(retained[retained.length - 1].id).toBe('cap-10000');
      expect(retained.some((e) => e.id === 'cap-0')).toBe(false);
      expect(retained.some((e) => e.id === 'cap-2000')).toBe(false);
    });

    it('continues accepting records normally after trimming', async () => {
      for (let i = 0; i <= 10000; i++) {
        await repo.record(
          makeAuditEvent({
            id: `cap-${i}`,
            timestamp: new Date(BASE_TIME.getTime() + i),
          }),
        );
      }

      await repo.record(makeAuditEvent({ id: 'cap-10001', timestamp: new Date(BASE_TIME.getTime() + 10001) }));

      expect(repo.getEventCount()).toBe(8001);
      await expect(repo.findByUserId('user-1', 1)).resolves.toEqual([
        makeAuditEvent({ id: 'cap-10001', timestamp: new Date(BASE_TIME.getTime() + 10001) }),
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// DatabaseSecurityAuditRepository
// ---------------------------------------------------------------------------

describe('DatabaseSecurityAuditRepository', () => {
  let pool: { query: jest.Mock };
  let repo: DatabaseSecurityAuditRepository;

  beforeEach(() => {
    pool = makePool();
    repo = new DatabaseSecurityAuditRepository(pool);
  });

  describe('record', () => {
    it('issues a single INSERT with the documented parameter order', async () => {
      const event = makeAuditEvent({ id: 'evt-1', type: 'AUTHORIZATION', outcome: 'FAILURE' });

      await repo.record(event);

      expect(pool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO security_audit_events');
      expect((sql.match(/\$\d+/g) ?? [])).toHaveLength(10);
      expect(params).toEqual([
        'evt-1',
        'AUTHORIZATION',
        'user-1',
        'session-1',
        'login',
        'session',
        'FAILURE',
        JSON.stringify({ method: 'password' }),
        JSON.stringify(event.securityContext),
        event.timestamp,
      ]);
    });

    it('serializes details/securityContext and passes the timestamp Date through by reference', async () => {
      const event = makeAuditEvent();

      await repo.record(event);

      const [, params] = pool.query.mock.calls[0];
      expect(params[7]).toBe(JSON.stringify({ method: 'password' }));
      expect(params[8]).toBe(JSON.stringify(event.securityContext));
      expect(params[9]).toBe(event.timestamp);
    });

    it('passes omitted optional userId/sessionId through as-is', async () => {
      const event = makeAuditEvent({ userId: undefined, sessionId: undefined });

      await repo.record(event);

      const [, params] = pool.query.mock.calls[0];
      expect(params[2]).toBeUndefined();
      expect(params[3]).toBeUndefined();
    });

    it('resolves once the pool query succeeds', async () => {
      pool.query.mockResolvedValue({ rowCount: 1 });

      await expect(repo.record(makeAuditEvent())).resolves.toBeUndefined();
    });

    it('propagates pool failures unchanged', async () => {
      const failure = new Error('connection terminated unexpectedly');
      pool.query.mockRejectedValue(failure);

      await expect(repo.record(makeAuditEvent())).rejects.toBe(failure);
    });
  });

  describe('findByUserId', () => {
    it('queries with [userId, limit] and orders newest-first', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await repo.findByUserId('user-1', 25);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('WHERE user_id = $1');
      expect(sql).toContain('ORDER BY timestamp DESC');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual(['user-1', 25]);
    });

    it('applies the default limit of 100', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await repo.findByUserId('user-1');

      expect(pool.query.mock.calls[0][1]).toEqual(['user-1', 100]);
    });

    it('maps snake_case rows and JSON-parses stringified columns', async () => {
      pool.query.mockResolvedValue({ rows: [makeDbRow()] });

      const events = await repo.findByUserId('user-1');

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-1');
      expect(events[0].type).toBe('AUTHENTICATION');
      expect(events[0].userId).toBe('user-1');
      expect(events[0].sessionId).toBe('session-1');
      expect(events[0].action).toBe('login');
      expect(events[0].resource).toBe('session');
      expect(events[0].outcome).toBe('SUCCESS');
      expect(events[0].details).toEqual({ method: 'password' });
      // JSONB is parsed as a plain object; the nested context timestamp stays
      // an ISO string because only the row-level timestamp is coerced.
      expect(events[0].securityContext).toEqual({
        requestId: 'req-1',
        ipAddress: '203.0.113.7',
        userAgent: 'jest-test-agent/1.0',
        timestamp: BASE_TIME_ISO,
      });
      expect(events[0].timestamp).toBeInstanceOf(Date);
      expect(events[0].timestamp.getTime()).toBe(BASE_TIME.getTime());
    });

    it('passes through JSONB values the driver already parsed into objects', async () => {
      const parsed = securityContextAt();
      pool.query.mockResolvedValue({
        rows: [
          makeDbRow({
            details: { method: 'password' },
            security_context: parsed,
          }),
        ],
      });

      const events = await repo.findByUserId('user-1');

      expect(events[0].details).toEqual({ method: 'password' });
      expect(events[0].securityContext).toEqual(parsed);
    });

    it('returns [] for an empty result set', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await expect(repo.findByUserId('user-1')).resolves.toEqual([]);
    });

    it('propagates pool failures unchanged', async () => {
      const failure = new Error('relation "security_audit_events" does not exist');
      pool.query.mockRejectedValue(failure);

      await expect(repo.findByUserId('user-1')).rejects.toBe(failure);
    });
  });

  describe('findBySessionId', () => {
    it('queries with [sessionId, limit] against session_id', async () => {
      pool.query.mockResolvedValue({ rows: [makeDbRow({ session_id: 'session-9' })] });

      const events = await repo.findBySessionId('session-9', 10);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('WHERE session_id = $1');
      expect(sql).toContain('ORDER BY timestamp DESC');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual(['session-9', 10]);
      expect(events).toHaveLength(1);
      expect(events[0].sessionId).toBe('session-9');
    });

    it('returns [] for an empty result set', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await expect(repo.findBySessionId('session-9')).resolves.toEqual([]);
    });
  });

  describe('findSecurityViolations', () => {
    it('filters server-side on type and timestamp >= since with [since, limit]', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      const since = new Date('2026-01-15T09:00:00.000Z');

      await repo.findSecurityViolations(since, 15);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain("type = 'SECURITY_VIOLATION'");
      expect(sql).toContain('timestamp >= $1');
      expect(sql).toContain('ORDER BY timestamp DESC');
      expect(sql).toContain('LIMIT $2');
      expect(params).toEqual([since, 15]);
    });

    it('maps returned violation rows to AuditEvents', async () => {
      pool.query.mockResolvedValue({
        rows: [makeDbRow({ type: 'SECURITY_VIOLATION', outcome: 'BLOCKED' })],
      });

      const events = await repo.findSecurityViolations(new Date(0));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('SECURITY_VIOLATION');
      expect(events[0].outcome).toBe('BLOCKED');
    });

    it('returns [] for an empty result set and propagates pool failures', async () => {
      pool.query.mockResolvedValue({ rows: [] });
      await expect(repo.findSecurityViolations(new Date(0))).resolves.toEqual([]);

      const failure = new Error('statement timeout');
      pool.query.mockRejectedValue(failure);
      await expect(repo.findSecurityViolations(new Date(0))).rejects.toBe(failure);
    });
  });
});

// ---------------------------------------------------------------------------
// SECURITY_AUDIT_EVENTS_SCHEMA
// ---------------------------------------------------------------------------

describe('SECURITY_AUDIT_EVENTS_SCHEMA', () => {
  it('declares the security_audit_events table', () => {
    expect(typeof SECURITY_AUDIT_EVENTS_SCHEMA).toBe('string');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA.length).toBeGreaterThan(0);
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain(
      'CREATE TABLE IF NOT EXISTS security_audit_events',
    );
  });

  it('keys the table by a VARCHAR(255) id', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('id VARCHAR(255) PRIMARY KEY');
  });

  it('constrains type to the four audited event types', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain(
      "type VARCHAR(50) NOT NULL CHECK (type IN ('AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'SECURITY_VIOLATION'))",
    );
  });

  it('constrains outcome to the three supported outcomes', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain(
      "outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'BLOCKED'))",
    );
  });

  it('requires action, resource, security_context and timestamp', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('action VARCHAR(255) NOT NULL');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('resource VARCHAR(255) NOT NULL');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('security_context JSONB NOT NULL');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain(
      'timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()',
    );
  });

  it('keeps user_id and session_id nullable', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('user_id VARCHAR(255),');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('session_id VARCHAR(255),');
  });

  it('stores details as optional JSONB', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('details JSONB,');
  });

  it('declares query indexes for user, session, type, outcome and timestamp', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_user_id (user_id)');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_session_id (session_id)');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_type (type)');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_outcome (outcome)');
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain('INDEX idx_audit_timestamp (timestamp)');
  });

  it('declares the partial index for security-violation lookups', () => {
    expect(SECURITY_AUDIT_EVENTS_SCHEMA).toContain(
      "INDEX idx_audit_security_violations (type, timestamp) WHERE type = 'SECURITY_VIOLATION'",
    );
  });
});

// ---------------------------------------------------------------------------
// createSecurityAuditRepository
// ---------------------------------------------------------------------------

describe('createSecurityAuditRepository', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it('returns the database repository in production when a pool is provided', () => {
    const repo = createSecurityAuditRepository(makePool(), 'production');
    expect(repo).toBeInstanceOf(DatabaseSecurityAuditRepository);
  });

  it('falls back to the in-memory repository in production without a pool', () => {
    const repo = createSecurityAuditRepository(undefined, 'production');
    expect(repo).toBeInstanceOf(InMemorySecurityAuditRepository);
  });

  it('returns the in-memory repository outside production even with a pool', () => {
    expect(createSecurityAuditRepository(makePool(), 'test')).toBeInstanceOf(
      InMemorySecurityAuditRepository,
    );
    expect(createSecurityAuditRepository(makePool(), 'development')).toBeInstanceOf(
      InMemorySecurityAuditRepository,
    );
  });

  it('defaults to the in-memory repository when NODE_ENV is unset', () => {
    delete process.env.NODE_ENV;

    const repo = createSecurityAuditRepository(makePool());
    expect(repo).toBeInstanceOf(InMemorySecurityAuditRepository);
  });
});

// ---------------------------------------------------------------------------
// Public re-export surface
// ---------------------------------------------------------------------------

describe('audit module re-exports', () => {
  it('re-exports the audit hash-chain utilities unchanged', () => {
    expect(auditModule.AUDIT_LOG_GENESIS_HASH).toBe(hashChainModule.AUDIT_LOG_GENESIS_HASH);
    expect(auditModule.buildAuditCanonicalPayload).toBe(
      hashChainModule.buildAuditCanonicalPayload,
    );
    expect(auditModule.computeAuditRowHash).toBe(hashChainModule.computeAuditRowHash);
    expect(auditModule.verifyAuditHashChain).toBe(hashChainModule.verifyAuditHashChain);
    expect(auditModule.verifyAuditLogIntegrity).toBe(hashChainModule.verifyAuditLogIntegrity);
  });

  it('re-exports the audit integrity scheduler unchanged', () => {
    expect(auditModule.AuditIntegrityScheduler).toBe(schedulerModule.AuditIntegrityScheduler);
    expect(auditModule.createAuditIntegrityScheduler).toBe(
      schedulerModule.createAuditIntegrityScheduler,
    );
  });
});
