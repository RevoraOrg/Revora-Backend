/**
 * Dedicated behaviour coverage for `src/security/auth.ts` (#1080).
 *
 * Scope
 * -----
 * `AuthMiddlewareDependencies` is the injection seam for both auth middlewares.
 * This suite exercises that seam directly:
 *
 *  - `extractAuthenticatedUser`   — extraction order, fallbacks, rejections
 *  - `createSecurityContext`      — proxy/header/connection fallbacks
 *  - `createAuthenticationMiddleware` — success / 401 / 500 transitions
 *  - `createAuthorizationMiddleware`  — 401 / 403 / grant transitions + audit shape
 *
 * Determinism notes
 * -----------------
 * `recordAuditEvent` is fire-and-forget, so every audit assertion waits for the
 * repository mock to be invoked instead of assuming synchronous ordering. All
 * other inputs (headers, roles, config) are fully controlled per test.
 *
 * NOTE: this file intentionally complements `auth_logic.test.ts` (happy-path
 * smoke coverage) rather than duplicating it.
 */

import { Request, Response } from 'express';
import {
  createAuthenticationMiddleware,
  createAuthorizationMiddleware,
  createSecurityContext,
  extractAuthenticatedUser,
} from './auth';
import {
  AuthenticationError,
  AuthorizationError,
  DEFAULT_SECURITY_CONFIG,
  type Permission,
  type SecurityAuditRepository,
  type SecurityConfig,
  type SecurityContext,
  type UserRole,
} from './types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeAuditRepository() {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    findByUserId: jest.fn().mockResolvedValue([]),
    findBySessionId: jest.fn().mockResolvedValue([]),
    findSecurityViolations: jest.fn().mockResolvedValue([]),
  };
}

type AuditMock = ReturnType<typeof makeAuditRepository>;

function makeResponse() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  const req: any = {
    method: 'POST',
    path: '/milestones/validate',
    originalUrl: '/milestones/validate',
    headers: {
      'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      'user-agent': 'jest-agent/1.0',
    },
    requestId: 'req-1080',
    connection: { remoteAddress: '10.0.0.1' },
    socket: { remoteAddress: '10.0.0.2' },
    ...overrides,
  };
  return req;
}

function makeSecurityContext(role: UserRole): SecurityContext {
  return {
    user: {
      id: `user-${role}`,
      role,
      permissions: [],
      sessionId: `sess-${role}`,
      authenticatedAt: new Date(),
    },
    requestId: 'req-1080',
    ipAddress: '203.0.113.7',
    userAgent: 'jest-agent/1.0',
    timestamp: new Date(),
  };
}

/** Wait until the fire-and-forget audit write has been observed. */
async function waitForAudit(repo: AuditMock, times = 1) {
  for (let i = 0; i < 50 && repo.record.mock.calls.length < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return repo.record.mock.calls;
}

describe('AuthMiddlewareDependencies (#1080)', () => {
  let auditRepository: AuditMock;

  beforeEach(() => {
    auditRepository = makeAuditRepository();
  });

  // ── extractAuthenticatedUser ──────────────────────────────────────────────

  describe('extractAuthenticatedUser', () => {
    it('prefers req.user over req.auth when both are present', () => {
      const req = makeRequest({
        user: { id: 'from-user', role: 'admin', sessionId: 'sess-user' },
        auth: { userId: 'from-auth', role: 'investor', sessionId: 'sess-auth' },
      });

      const user = extractAuthenticatedUser(req as Request);

      expect(user.id).toBe('from-user');
      expect(user.role).toBe('admin');
      expect(user.sessionId).toBe('sess-user');
    });

    it('falls back to req.auth when req.user is absent', () => {
      const req = makeRequest({
        auth: { userId: 'auth-only', role: 'verifier', sessionId: 'sess-1' },
      });

      const user = extractAuthenticatedUser(req as Request);

      expect(user).toMatchObject({ id: 'auth-only', role: 'verifier', sessionId: 'sess-1' });
    });

    it('falls back to user.sessionToken when sessionId is missing', () => {
      const req = makeRequest({
        user: { id: 'u-token', role: 'issuer', sessionToken: 'token-fallback' },
      });

      expect(extractAuthenticatedUser(req as Request).sessionId).toBe('token-fallback');
    });

    it('uses "unknown" when neither sessionId nor sessionToken is supplied', () => {
      const req = makeRequest({ user: { id: 'u-anon-session', role: 'investor' } });

      expect(extractAuthenticatedUser(req as Request).sessionId).toBe('unknown');
    });

    it('returns an empty permission set and a Date for authenticatedAt', () => {
      const req = makeRequest({ user: { id: 'u-shape', role: 'admin' } });

      const user = extractAuthenticatedUser(req as Request);

      // Permissions are populated later by the authorization middleware.
      expect(user.permissions).toEqual([]);
      expect(user.authenticatedAt).toBeInstanceOf(Date);
    });

    it.each([
      ['no identity at all', {}],
      ['id without role', { user: { id: 'u-1' } }],
      ['role without id', { user: { role: 'admin' } }],
    ])('rejects %s with AuthenticationError', (_label, overrides) => {
      const req = makeRequest(overrides as Record<string, unknown>);

      expect(() => extractAuthenticatedUser(req as Request)).toThrow(AuthenticationError);
    });

    it('reports extraction diagnostics on the rejection', () => {
      const req = makeRequest({ auth: {} });

      try {
        extractAuthenticatedUser(req as Request);
        throw new Error('expected AuthenticationError');
      } catch (error) {
        expect(error).toBeInstanceOf(AuthenticationError);
        expect((error as AuthenticationError).details).toMatchObject({
          hasUser: false,
          hasAuth: false,
          requestId: 'req-1080',
        });
      }
    });

    it.each(['root', 'ADMIN', 'admin ', 'owner'])(
      'rejects out-of-enum role %p',
      (role) => {
        const req = makeRequest({ user: { id: 'u-role', role } });

        expect(() => extractAuthenticatedUser(req as Request)).toThrow('Invalid user role');
      },
    );

    it('rejects an empty role as missing identity rather than as an unknown role', () => {
      const req = makeRequest({ user: { id: 'u-empty-role', role: '' } });

      // Falsy role fails the "has an identity" guard before enum validation.
      expect(() => extractAuthenticatedUser(req as Request)).toThrow(AuthenticationError);
    });

    it.each(['admin', 'verifier', 'issuer', 'investor'] as UserRole[])(
      'accepts enum role %p',
      (role) => {
        const req = makeRequest({ user: { id: 'u-ok', role } });

        expect(extractAuthenticatedUser(req as Request).role).toBe(role);
      },
    );

    it('lists the valid roles in the invalid-role diagnostics', () => {
      const req = makeRequest({ user: { id: 'u-bad', role: 'superuser' } });

      try {
        extractAuthenticatedUser(req as Request);
        throw new Error('expected AuthenticationError');
      } catch (error) {
        expect((error as AuthenticationError).details?.validRoles).toEqual([
          'admin',
          'verifier',
          'issuer',
          'investor',
        ]);
      }
    });
  });

  // ── createSecurityContext ─────────────────────────────────────────────────

  describe('createSecurityContext', () => {
    const user = {
      id: 'u-ctx',
      role: 'admin' as UserRole,
      permissions: [],
      sessionId: 'sess-ctx',
      authenticatedAt: new Date(),
    };

    it('uses the first entry of a multi-hop X-Forwarded-For header', () => {
      const req = makeRequest({
        headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.1, 10.0.0.5' },
      });

      expect(createSecurityContext(req as Request, user).ipAddress).toBe('198.51.100.9');
    });

    it('falls back to connection.remoteAddress when X-Forwarded-For is absent', () => {
      const req = makeRequest({
        headers: { 'user-agent': 'ua' },
        connection: { remoteAddress: '192.0.2.44' },
      });

      expect(createSecurityContext(req as Request, user).ipAddress).toBe('192.0.2.44');
    });

    it('falls back to socket.remoteAddress when connection is absent', () => {
      const req = makeRequest({
        headers: {},
        connection: undefined,
        socket: { remoteAddress: '192.0.2.99' },
      });

      expect(createSecurityContext(req as Request, user).ipAddress).toBe('192.0.2.99');
    });

    it('defaults to "unknown" when no address source exists', () => {
      const req = makeRequest({ headers: {}, connection: undefined, socket: undefined });

      expect(createSecurityContext(req as Request, user).ipAddress).toBe('unknown');
    });

    it('defaults userAgent and requestId to "unknown" when missing', () => {
      const req = makeRequest({ headers: {}, requestId: undefined });

      const context = createSecurityContext(req as Request, user);

      expect(context.userAgent).toBe('unknown');
      expect(context.requestId).toBe('unknown');
    });

    it('embeds the provided user by reference and stamps a Date', () => {
      const req = makeRequest();

      const context = createSecurityContext(req as Request, user);

      expect(context.user).toBe(user);
      expect(context.timestamp).toBeInstanceOf(Date);
    });
  });

  // ── createAuthenticationMiddleware ────────────────────────────────────────

  describe('createAuthenticationMiddleware', () => {
    function build(repo: AuditMock = auditRepository) {
      const deps = { auditRepository: repo as unknown as SecurityAuditRepository };
      const res = makeResponse();
      const next = jest.fn();
      const middleware = createAuthenticationMiddleware(deps);
      return { res, next, middleware, deps };
    }

    it('attaches the security context, audits SUCCESS and calls next()', async () => {
      const req = makeRequest({ user: { id: 'u-1', role: 'admin', sessionId: 'sess-1' } });
      const { res, next, middleware } = build();

      await middleware(req as Request, res as Response, next as any);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.securityContext).toBeDefined();
      expect(req.securityContext.user.id).toBe('u-1');
      expect(req.securityContext.userAgent).toBe('jest-agent/1.0');
      expect(res.status).not.toHaveBeenCalled();

      const [event] = await waitForAudit(auditRepository);
      expect(event[0]).toMatchObject({
        type: 'AUTHENTICATION',
        action: 'user_authenticated',
        resource: 'auth_system',
        outcome: 'SUCCESS',
        userId: 'u-1',
        sessionId: 'sess-1',
      });
      expect(event[0].details).toMatchObject({ role: 'admin' });
      expect(event[0].securityContext.requestId).toBe('req-1080');
      // The audit context must not leak the full user object (only identity keys).
      expect(event[0].securityContext).not.toHaveProperty('user');
    });

    it('returns 401, does not call next() and does not attach a context on failure', async () => {
      const req = makeRequest();
      const { res, next, middleware } = build();

      await middleware(req as Request, res as Response, next as any);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body).toEqual({
        error: 'Authentication failed',
        code: 'AUTHENTICATION_FAILED',
        requestId: 'req-1080',
      });
      expect(next).not.toHaveBeenCalled();
      expect(req.securityContext).toBeUndefined();
    });

    it('audits the failure with the error code before rejecting the request', async () => {
      const req = makeRequest({ user: { id: 'u-role', role: 'not-a-role' } });
      const { res, middleware } = build();

      await middleware(req as Request, res as Response, jest.fn() as any);

      const [event] = await waitForAudit(auditRepository);
      expect(event[0]).toMatchObject({
        type: 'AUTHENTICATION',
        action: 'user_authentication_failed',
        outcome: 'FAILURE',
      });
      expect(event[0].details).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      expect(event[0].securityContext.ipAddress).toBe('203.0.113.7');
      expect(res.statusCode).toBe(401);
    });

    it('returns 500 when an unexpected (non-auth) error escapes', async () => {
      // The initial header read throws once; the catch block re-reads headers
      // for the anomaly context and must still respond deterministically.
      let reads = 0;
      const req: any = {
        method: 'POST',
        path: '/milestones/validate',
        requestId: 'req-boom',
        ip: '198.51.100.3',
        user: { id: 'u-boom', role: 'admin' },
      };
      Object.defineProperty(req, 'headers', {
        get() {
          reads += 1;
          if (reads === 1) throw new Error('header access exploded');
          return { 'user-agent': 'partial-agent' };
        },
      });

      const { res, next, middleware } = build();

      await middleware(req as Request, res as Response, next as any);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.body).toMatchObject({
        error: 'Internal authentication error',
        requestId: 'req-boom',
      });
      expect(next).not.toHaveBeenCalled();
      // Non-AuthenticationError failures are not written to the audit trail.
      expect(auditRepository.record).not.toHaveBeenCalled();
    });

    it('does not break the request when the audit repository rejects', async () => {
      auditRepository.record.mockRejectedValue(new Error('audit backend down'));
      const req = makeRequest({ user: { id: 'u-1', role: 'admin' } });
      const { res, next, middleware } = build();

      await middleware(req as Request, res as Response, next as any);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('uses the production default matrix when deps omit config', async () => {
      const req = makeRequest({ user: { id: 'u-1', role: 'verifier', sessionId: 'sess-v' } });
      const res = makeResponse();
      const next = jest.fn();

      // `config` is deliberately omitted from the dependency bag.
      await createAuthenticationMiddleware({
        auditRepository: auditRepository as unknown as SecurityAuditRepository,
      })(req as Request, res as Response, next as any);

      expect(next).toHaveBeenCalledTimes(1);

      const nextAuthz = jest.fn();
      await createAuthorizationMiddleware(['milestone:validate'], {
        auditRepository: auditRepository as unknown as SecurityAuditRepository,
      })(req as Request, res as Response, nextAuthz as any);

      expect(nextAuthz).toHaveBeenCalledTimes(1);
      expect(req.securityContext.user.permissions).toEqual(
        DEFAULT_SECURITY_CONFIG.enabledPermissions.verifier,
      );
    });
  });

  // ── createAuthorizationMiddleware ─────────────────────────────────────────

  describe('createAuthorizationMiddleware', () => {
    function build(requiredPermissions: Permission[], config?: SecurityConfig) {
      const res = makeResponse();
      const next = jest.fn();
      const middleware = createAuthorizationMiddleware(requiredPermissions, {
        auditRepository: auditRepository as unknown as SecurityAuditRepository,
        ...(config ? { config } : {}),
      });
      return { res, next, middleware };
    }

    it('returns 401 when no security context is attached', async () => {
      const req = makeRequest();
      const { res, next, middleware } = build(['milestone:validate']);

      await middleware(req as Request, res as Response, next as any);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body).toMatchObject({ error: 'Authentication required' });
      expect(next).not.toHaveBeenCalled();

      const [event] = await waitForAudit(auditRepository);
      expect(event[0]).toMatchObject({
        type: 'AUTHORIZATION',
        action: 'authorization_attempt_without_context',
        outcome: 'FAILURE',
      });
      expect(event[0].details).toMatchObject({ requiredPermissions: ['milestone:validate'] });
      expect(event[0].securityContext.user.id).toBe('unknown');
    });

    it('grants access, hydrates permissions and audits SUCCESS', async () => {
      const req = makeRequest({ securityContext: makeSecurityContext('admin') });
      const { res, next, middleware } = build(['milestone:validate', 'vault:manage']);

      await middleware(req as Request, res as Response, next as any);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      expect(req.securityContext.user.permissions).toEqual(
        DEFAULT_SECURITY_CONFIG.enabledPermissions.admin,
      );

      const [event] = await waitForAudit(auditRepository);
      expect(event[0]).toMatchObject({
        action: 'permission_granted',
        outcome: 'SUCCESS',
      });
      expect(event[0].details).toMatchObject({
        userRole: 'admin',
        requiredPermissions: ['milestone:validate', 'vault:manage'],
        resource: 'POST /milestones/validate',
      });
    });

    it.each([
      ['verifier cannot manage the vault', 'verifier', ['vault:manage']],
      ['issuer cannot validate milestones', 'issuer', ['milestone:validate']],
      ['investor cannot read the audit log', 'investor', ['audit:read']],
    ] as const)('returns 403 when %s', async (_label, role, required) => {
      const req = makeRequest({ securityContext: makeSecurityContext(role) });
      const { res, next, middleware } = build(required as unknown as Permission[]);

      await middleware(req as Request, res as Response, next as any);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toMatchObject({
        error: 'Authorization failed',
        code: 'AUTHORIZATION_FAILED',
      });
      expect(next).not.toHaveBeenCalled();

      const [event] = await waitForAudit(auditRepository);
      expect(event[0]).toMatchObject({ action: 'permission_denied', outcome: 'FAILURE' });
      expect(event[0].details).toMatchObject({ userRole: role, requiredPermissions: required });
    });

    it('denies when only a subset of the required permissions is held', async () => {
      // verifier holds milestone:validate + milestone:view but not audit:read.
      const req = makeRequest({ securityContext: makeSecurityContext('verifier') });
      const { res, next, middleware } = build(['milestone:validate', 'audit:read']);

      await middleware(req as Request, res as Response, next as any);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows a request with no required permissions (vacuous grant)', async () => {
      const req = makeRequest({ securityContext: makeSecurityContext('investor') });
      const { res, next, middleware } = build([]);

      await middleware(req as Request, res as Response, next as any);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('honours the injected enabledPermissions matrix', async () => {
      const config: SecurityConfig = {
        ...DEFAULT_SECURITY_CONFIG,
        enabledPermissions: {
          ...DEFAULT_SECURITY_CONFIG.enabledPermissions,
          investor: ['vault:manage'],
        },
      };

      const allowed = makeRequest({ securityContext: makeSecurityContext('investor') });
      const allowedRun = build(['vault:manage'], config);
      await allowedRun.middleware(allowed as Request, allowedRun.res as Response, allowedRun.next as any);
      expect(allowedRun.next).toHaveBeenCalledTimes(1);

      // The same role is still denied for a permission the override removed.
      auditRepository.record.mockClear();
      const denied = makeRequest({ securityContext: makeSecurityContext('investor') });
      const deniedRun = build(['milestone:view'], config);
      await deniedRun.middleware(denied as Request, deniedRun.res as Response, deniedRun.next as any);
      expect(deniedRun.res.statusCode).toBe(403);
      expect(deniedRun.next).not.toHaveBeenCalled();
    });

    it('surfaces an unknown role as a denial instead of throwing', async () => {
      const context = makeSecurityContext('investor');
      (context.user as { role: string }).role = 'ghost-role';
      const req = makeRequest({ securityContext: context });
      const { res, next, middleware } = build(['milestone:view']);

      await middleware(req as Request, res as Response, next as any);

      expect(res.statusCode).toBe(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('exposes AuthorizationError as a SecurityError with the FAILED code', () => {
      const error = new AuthorizationError('Insufficient permissions', {
        requiredPermissions: ['audit:read'],
      });

      expect(error).toBeInstanceOf(AuthorizationError);
      expect(error.code).toBe('AUTHORIZATION_FAILED');
      expect(error.name).toBe('SecurityError');
    });
  });
});
