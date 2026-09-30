/**
 * @file src/auth/social/socialAuthRoute.test.ts
 * @description Dedicated behavior test suite for `createSocialAuthRouter` and the
 * `SocialAuthRouterDependencies` injection contract.
 *
 * Covers:
 *  - Public router contract & mountable Express routes
 *  - Dependency injection & isolation (services, auth middleware, rate-limit policies)
 *  - POST /api/auth/social/:provider/login
 *      - Happy path for supported providers (google, apple)
 *      - Representative invalid inputs (unsupported provider, empty/missing/non-string token)
 *      - Service error mappings and failure transitions (400, 401, 404, 409)
 *      - Anti-enumeration rate limiting (per-sub bucketing, IP fallback, 429 status)
 *      - Unexpected service errors routed to error handling middleware (500)
 *  - POST /api/auth/social/:provider/link
 *      - Auth guard boundary enforcement via requireAuth
 *      - Confirmation requirement (confirm: true)
 *      - Representative invalid inputs & missing user context
 *      - Successful link state transition
 *      - Conflict & failure state transitions (409, 400, 500)
 *  - DELETE /api/auth/social/:provider/link
 *      - Auth guard boundary enforcement via requireAuth
 *      - Confirmation requirement (confirm: true)
 *      - Representative invalid inputs & missing user context
 *      - Successful unlink state transition
 *      - Failure state transitions (401, 404, 500)
 */

import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import request from 'supertest';
import {
  createSocialAuthRouter,
  SocialAuthRouterDependencies,
} from './socialAuthRoute';
import {
  SocialAuthError,
  SocialAuthProvider,
  SocialIdentityRecord,
  SocialLoginResult,
} from './types';
import type { SocialAuthService } from './socialAuthService';
import { errorHandler } from '../../middleware/errorHandler';
import { InMemoryRateLimitStore } from '../../middleware/rateLimit';

// ── Helpers & Fakes ─────────────────────────────────────────────────────────

/**
 * Creates an unverified compact JWT string with a base64url payload.
 * Used for testing anti-enumeration extraction and login flows.
 */
function makeCompactJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.mock-signature`;
}

type MockSocialAuthService = {
  loginWithProvider: jest.Mock;
  linkProvider: jest.Mock;
  unlinkProvider: jest.Mock;
};

function createMockSocialAuthService(): MockSocialAuthService {
  return {
    loginWithProvider: jest.fn(),
    linkProvider: jest.fn(),
    unlinkProvider: jest.fn(),
  };
}

function makeMockIdentity(overrides: Partial<SocialIdentityRecord> = {}): SocialIdentityRecord {
  return {
    id: 'identity-123',
    userId: 'user-xyz',
    provider: 'google',
    providerSubject: 'google-sub-456',
    providerEmail: 'founder@example.com',
    emailVerified: true,
    isPrivateRelay: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const mockLoginSuccess: SocialLoginResult = {
  accessToken: 'mock-access-token-xyz',
  refreshToken: 'mock-refresh-token-abc',
  user: {
    id: 'user-xyz',
    email: 'founder@example.com',
    role: 'startup',
  },
};

interface TestHarness {
  app: express.Express;
  mockService: MockSocialAuthService;
  requireAuthMock: jest.Mock;
  deps: SocialAuthRouterDependencies;
  rateLimitStore: InMemoryRateLimitStore;
}

interface HarnessOptions {
  authPasses?: boolean;
  authenticatedUserId?: string | null;
  depsOverrides?: Partial<SocialAuthRouterDependencies>;
}

function createHarness(options: HarnessOptions = {}): TestHarness {
  const {
    authPasses = true,
    authenticatedUserId = 'user-xyz',
    depsOverrides = {},
  } = options;

  const mockService = createMockSocialAuthService();
  const rateLimitStore = new InMemoryRateLimitStore();

  interface RequestWithUser extends Request {
    user?: { id?: string; sub?: string };
  }

  const requireAuthMock = jest.fn((req: Request, res: Response, next: NextFunction) => {
    if (!authPasses) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    if (authenticatedUserId !== null) {
      (req as RequestWithUser).user = { id: authenticatedUserId };
    }
    next();
  });

  const deps: SocialAuthRouterDependencies = {
    socialAuthService: mockService as unknown as SocialAuthService,
    requireAuth: requireAuthMock as unknown as RequestHandler,
    antiEnumerationOptions: {
      store: rateLimitStore,
      limit: 5,
      windowMs: 60_000,
      ipFallbackLimit: 10,
    },
    ...depsOverrides,
  };

  const app = express();
  app.use(express.json());
  app.use(createSocialAuthRouter(deps));

  app.use(errorHandler);

  return { app, mockService, requireAuthMock, deps, rateLimitStore };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SocialAuthRouterDependencies & createSocialAuthRouter contract', () => {
  it('returns a configured Express Router with the expected route stack', () => {
    const harness = createHarness();
    const router = createSocialAuthRouter(harness.deps);

    expect(typeof router).toBe('function');
    interface RouterLayer {
      route?: {
        path: string;
        methods: Record<string, boolean>;
      };
    }
    const stack = (router as unknown as { stack: RouterLayer[] }).stack;
    expect(Array.isArray(stack)).toBe(true);

    const routeEntries = stack
      .filter((layer): layer is RouterLayer & { route: NonNullable<RouterLayer['route']> } => Boolean(layer.route))
      .map((layer) => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));

    expect(routeEntries).toEqual(
      expect.arrayContaining([
        { path: '/api/auth/social/:provider/login', methods: ['post'] },
        { path: '/api/auth/social/:provider/link', methods: ['post'] },
        { path: '/api/auth/social/:provider/link', methods: ['delete'] },
      ]),
    );
  });

  it('mounts successfully with minimal dependencies (antiEnumerationOptions omitted)', async () => {
    const mockService = createMockSocialAuthService();
    mockService.loginWithProvider.mockResolvedValue(mockLoginSuccess);

    const app = express();
    app.use(express.json());
    app.use(
      createSocialAuthRouter({
        socialAuthService: mockService as unknown as SocialAuthService,
        requireAuth: (_req, _res, next) => next(),
      }),
    );

    const validJwt = makeCompactJwt({ sub: 'default-sub-1' });
    const res = await request(app)
      .post('/api/auth/social/google/login')
      .send({ idToken: validJwt });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockLoginSuccess);
  });

  it('keeps rate limiting and state strictly isolated between distinct router instances', async () => {
    const storeA = new InMemoryRateLimitStore();
    const storeB = new InMemoryRateLimitStore();

    const harnessA = createHarness({
      depsOverrides: {
        antiEnumerationOptions: { store: storeA, limit: 1, windowMs: 60_000 },
      },
    });
    const harnessB = createHarness({
      depsOverrides: {
        antiEnumerationOptions: { store: storeB, limit: 1, windowMs: 60_000 },
      },
    });

    harnessA.mockService.loginWithProvider.mockResolvedValue(mockLoginSuccess);
    harnessB.mockService.loginWithProvider.mockResolvedValue(mockLoginSuccess);

    const token = makeCompactJwt({ sub: 'isolated-sub-1' });

    // Exhaust quota on router A
    const resA1 = await request(harnessA.app)
      .post('/api/auth/social/google/login')
      .send({ idToken: token });
    expect(resA1.status).toBe(200);

    const resA2 = await request(harnessA.app)
      .post('/api/auth/social/google/login')
      .send({ idToken: token });
    expect(resA2.status).toBe(429);
    expect(resA2.body.code).toBe('TOO_MANY_REQUESTS');

    // Router B with its own store must still accept the same sub
    const resB1 = await request(harnessB.app)
      .post('/api/auth/social/google/login')
      .send({ idToken: token });
    expect(resB1.status).toBe(200);
  });
});

describe('POST /api/auth/social/:provider/login', () => {
  it.each(['google', 'apple'] as SocialAuthProvider[])(
    'successfully logs in with supported provider "%s"',
    async (provider) => {
      const { app, mockService, requireAuthMock } = createHarness();
      mockService.loginWithProvider.mockResolvedValue(mockLoginSuccess);

      const token = makeCompactJwt({ sub: `${provider}-user-1` });
      const res = await request(app)
        .post(`/api/auth/social/${provider}/login`)
        .send({ idToken: token });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockLoginSuccess);
      expect(mockService.loginWithProvider).toHaveBeenCalledWith(provider, token);
      // Login endpoint is public: requireAuth must not be invoked
      expect(requireAuthMock).not.toHaveBeenCalled();
    },
  );

  describe('representative invalid inputs', () => {
    it.each([
      ['unsupported string', 'facebook'],
      ['github', 'github'],
      ['uppercase', 'GOOGLE'],
      ['numeric', '123'],
      ['special characters', 'google!'],
    ])('rejects unsupported provider "%s" (%s) with 400 INVALID_PROVIDER', async (_label, invalidProvider) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post(`/api/auth/social/${invalidProvider}/login`)
        .send({ idToken: makeCompactJwt({ sub: 'any' }) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_PROVIDER',
        message: 'Unsupported social auth provider.',
      });
      expect(mockService.loginWithProvider).not.toHaveBeenCalled();
    });

    it('rejects empty request body with 400 INVALID_TOKEN', async () => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'idToken is required.',
      });
      expect(mockService.loginWithProvider).not.toHaveBeenCalled();
    });

    it('rejects request body missing idToken field with 400 INVALID_TOKEN', async () => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/login')
        .send({ notIdToken: 'some-value' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'idToken is required.',
      });
      expect(mockService.loginWithProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['number', 12345],
      ['boolean', true],
      ['null', null],
      ['object', { nested: 'token' }],
      ['array', ['token-in-array']],
      ['empty string', ''],
      ['whitespace string', '    '],
    ])('rejects non-string or blank idToken (%s) with 400 INVALID_TOKEN', async (_label, invalidToken) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: invalidToken });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'idToken is required.',
      });
      expect(mockService.loginWithProvider).not.toHaveBeenCalled();
    });
  });

  describe('service error handling and state transitions', () => {
    it.each([
      ['INVALID_TOKEN', 400, 'Invalid token signature'],
      ['PROVIDER_NOT_CONFIGURED', 400, 'Provider client ID not configured'],
      ['UNVERIFIED_EMAIL', 400, 'Email address has not been verified by provider'],
      ['STEP_UP_REQUIRED', 401, 'Multi-factor or step-up authentication required'],
      ['SOCIAL_IDENTITY_NOT_LINKED', 401, 'No user found for this social identity'],
      ['EMAIL_ACCOUNT_REQUIRES_LINK', 401, 'Account exists with password; link required'],
      ['USER_NOT_FOUND', 404, 'Associated user was not found'],
      ['IDENTITY_LINKED_TO_ANOTHER_USER', 409, 'Identity belongs to a different account'],
    ] as const)('maps SocialAuthError(%s) to HTTP status %d', async (code, expectedStatus, message) => {
      const { app, mockService } = createHarness();
      mockService.loginWithProvider.mockRejectedValue(new SocialAuthError(code, message));

      const res = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: makeCompactJwt({ sub: 'err-sub' }) });

      expect(res.status).toBe(expectedStatus);
      expect(res.body).toEqual({
        error: code,
        message,
      });
    });

    it('forwards unexpected service rejections to Express error middleware (500)', async () => {
      const { app, mockService } = createHarness();
      mockService.loginWithProvider.mockRejectedValue(new Error('PostgreSQL connection terminated'));

      const res = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: makeCompactJwt({ sub: 'db-err-sub' }) });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('anti-enumeration policy behavior', () => {
    it('enforces per-provider-sub rate limit and returns 429 when quota exceeded', async () => {
      const rateLimitStore = new InMemoryRateLimitStore();
      const customMessage = 'Rate limit exceeded for social authentication.';
      const { app, mockService } = createHarness({
        depsOverrides: {
          antiEnumerationOptions: {
            store: rateLimitStore,
            limit: 2,
            windowMs: 60_000,
            message: customMessage,
          },
        },
      });

      mockService.loginWithProvider.mockResolvedValue(mockLoginSuccess);

      const targetSubToken = makeCompactJwt({ sub: 'target-sub-99' });
      const otherSubToken = makeCompactJwt({ sub: 'different-sub-11' });

      // Request 1: allowed
      const res1 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: targetSubToken });
      expect(res1.status).toBe(200);

      // Request 2: allowed
      const res2 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: targetSubToken });
      expect(res2.status).toBe(200);

      // Request 3: blocked per-sub
      const res3 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: targetSubToken });
      expect(res3.status).toBe(429);
      expect(res3.body).toEqual(
        expect.objectContaining({
          code: 'TOO_MANY_REQUESTS',
          message: customMessage,
        }),
      );

      // Distinct sub on same endpoint must remain unblocked
      const resOther = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: otherSubToken });
      expect(resOther.status).toBe(200);
    });

    it('falls back to IP-based rate limiting when subject cannot be parsed from idToken', async () => {
      const rateLimitStore = new InMemoryRateLimitStore();
      const { app } = createHarness({
        depsOverrides: {
          antiEnumerationOptions: {
            store: rateLimitStore,
            limit: 10,
            ipFallbackLimit: 2,
            windowMs: 60_000,
          },
        },
      });

      // Malformed JWT with non-parseable payload -> falls back to IP limiter
      const malformedToken = 'invalid.not-json-base64.sig';

      const res1 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: malformedToken });
      // Handler runs because extractProviderSub returns null; handler checks token validity or mock fails
      expect(res1.status).not.toBe(429);

      const res2 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: malformedToken });
      expect(res2.status).not.toBe(429);

      // 3rd attempt from same IP exceeds ipFallbackLimit of 2
      const res3 = await request(app)
        .post('/api/auth/social/google/login')
        .send({ idToken: malformedToken });
      expect(res3.status).toBe(429);
      expect(res3.body.code).toBe('TOO_MANY_REQUESTS');
    });
  });
});

describe('POST /api/auth/social/:provider/link', () => {
  it('enforces requireAuth guard before reaching the route handler', async () => {
    const { app, mockService } = createHarness({ authPasses: false });

    const res = await request(app)
      .post('/api/auth/social/google/link')
      .send({
        confirm: true,
        idToken: makeCompactJwt({ sub: 'link-sub-1' }),
        currentPassword: 'secretPassword123!',
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect(mockService.linkProvider).not.toHaveBeenCalled();
  });

  it('successfully links social provider when inputs and auth context are valid', async () => {
    const { app, mockService, requireAuthMock } = createHarness();
    const identity = makeMockIdentity({
      provider: 'google',
      providerEmail: 'linked@example.com',
    });
    mockService.linkProvider.mockResolvedValue({ linked: true, identity });

    const idToken = makeCompactJwt({ sub: 'google-sub-456' });
    const res = await request(app)
      .post('/api/auth/social/google/link')
      .send({
        confirm: true,
        idToken,
        currentPassword: 'currentPassword123!',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      linked: true,
      provider: 'google',
      providerEmail: 'linked@example.com',
    });
    expect(requireAuthMock).toHaveBeenCalledTimes(1);
    expect(mockService.linkProvider).toHaveBeenCalledWith({
      userId: 'user-xyz',
      provider: 'google',
      idToken,
      currentPassword: 'currentPassword123!',
    });
  });

  describe('representative invalid inputs', () => {
    it.each([
      ['missing confirm', {}],
      ['confirm is false', { confirm: false }],
      ['confirm is string "true"', { confirm: 'true' }],
      ['confirm is number 1', { confirm: 1 }],
      ['confirm is null', { confirm: null }],
    ])('rejects missing or invalid confirm flag (%s) with 401 STEP_UP_REQUIRED', async (_label, bodyOverrides) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send({
          idToken: makeCompactJwt({ sub: 'any' }),
          currentPassword: 'password123',
          ...bodyOverrides,
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Link changes require confirm: true.',
      });
      expect(mockService.linkProvider).not.toHaveBeenCalled();
    });

    it('rejects when authenticated user ID is not available on request context', async () => {
      const { app, mockService } = createHarness({
        authPasses: true,
        authenticatedUserId: null,
      });

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send({
          confirm: true,
          idToken: makeCompactJwt({ sub: 'any' }),
          currentPassword: 'password123',
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Authenticated user is required.',
      });
      expect(mockService.linkProvider).not.toHaveBeenCalled();
    });

    it('rejects unsupported provider with 400 INVALID_PROVIDER', async () => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/github/link')
        .send({
          confirm: true,
          idToken: makeCompactJwt({ sub: 'any' }),
          currentPassword: 'password123',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_PROVIDER',
        message: 'Unsupported social auth provider.',
      });
      expect(mockService.linkProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['missing idToken', { confirm: true, currentPassword: 'pass' }],
      ['empty idToken', { confirm: true, idToken: '', currentPassword: 'pass' }],
      ['whitespace idToken', { confirm: true, idToken: '   ', currentPassword: 'pass' }],
      ['number idToken', { confirm: true, idToken: 123, currentPassword: 'pass' }],
    ])('rejects invalid idToken (%s) with 400 INVALID_TOKEN', async (_label, body) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'idToken is required.',
      });
      expect(mockService.linkProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['missing currentPassword', { confirm: true, idToken: 'token-abc' }],
      ['empty currentPassword', { confirm: true, idToken: 'token-abc', currentPassword: '' }],
      ['whitespace currentPassword', { confirm: true, idToken: 'token-abc', currentPassword: '   ' }],
      ['boolean currentPassword', { confirm: true, idToken: 'token-abc', currentPassword: true }],
    ])('rejects invalid currentPassword (%s) with 400 INVALID_TOKEN', async (_label, body) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'currentPassword is required.',
      });
      expect(mockService.linkProvider).not.toHaveBeenCalled();
    });
  });

  describe('service error handling and state transitions', () => {
    it('returns 409 when identity is already linked to another user', async () => {
      const { app, mockService } = createHarness();
      mockService.linkProvider.mockRejectedValue(
        new SocialAuthError(
          'IDENTITY_LINKED_TO_ANOTHER_USER',
          'This Google account is already linked to another user.',
        ),
      );

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send({
          confirm: true,
          idToken: makeCompactJwt({ sub: 'sub-claimed' }),
          currentPassword: 'secretPassword123!',
        });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'IDENTITY_LINKED_TO_ANOTHER_USER',
        message: 'This Google account is already linked to another user.',
      });
    });

    it('returns 400 when service rejects with UNVERIFIED_EMAIL', async () => {
      const { app, mockService } = createHarness();
      mockService.linkProvider.mockRejectedValue(
        new SocialAuthError('UNVERIFIED_EMAIL', 'Social identity email is unverified.'),
      );

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send({
          confirm: true,
          idToken: makeCompactJwt({ sub: 'unverified-sub' }),
          currentPassword: 'secretPassword123!',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'UNVERIFIED_EMAIL',
        message: 'Social identity email is unverified.',
      });
    });

    it('routes unexpected link failures to Express error middleware (500)', async () => {
      const { app, mockService } = createHarness();
      mockService.linkProvider.mockRejectedValue(new Error('Transaction deadlock'));

      const res = await request(app)
        .post('/api/auth/social/google/link')
        .send({
          confirm: true,
          idToken: makeCompactJwt({ sub: 'sub-err' }),
          currentPassword: 'secretPassword123!',
        });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
    });
  });
});

describe('DELETE /api/auth/social/:provider/link', () => {
  it('enforces requireAuth guard before reaching the unlink handler', async () => {
    const { app, mockService } = createHarness({ authPasses: false });

    const res = await request(app)
      .delete('/api/auth/social/google/link')
      .send({
        confirm: true,
        currentPassword: 'password123',
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect(mockService.unlinkProvider).not.toHaveBeenCalled();
  });

  it('successfully unlinks social provider when inputs and auth context are valid', async () => {
    const { app, mockService, requireAuthMock } = createHarness();
    mockService.unlinkProvider.mockResolvedValue({ unlinked: true });

    const res = await request(app)
      .delete('/api/auth/social/google/link')
      .send({
        confirm: true,
        currentPassword: 'currentPassword123!',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unlinked: true });
    expect(requireAuthMock).toHaveBeenCalledTimes(1);
    expect(mockService.unlinkProvider).toHaveBeenCalledWith({
      userId: 'user-xyz',
      provider: 'google',
      currentPassword: 'currentPassword123!',
    });
  });

  describe('representative invalid inputs', () => {
    it.each([
      ['missing confirm', {}],
      ['confirm: false', { confirm: false }],
      ['confirm: "true"', { confirm: 'true' }],
      ['confirm: null', { confirm: null }],
    ])('rejects missing or invalid confirm flag (%s) with 401 STEP_UP_REQUIRED', async (_label, bodyOverrides) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send({
          currentPassword: 'password123',
          ...bodyOverrides,
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Link changes require confirm: true.',
      });
      expect(mockService.unlinkProvider).not.toHaveBeenCalled();
    });

    it('rejects when authenticated user ID is not available on request context', async () => {
      const { app, mockService } = createHarness({
        authPasses: true,
        authenticatedUserId: null,
      });

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send({
          confirm: true,
          currentPassword: 'password123',
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Authenticated user is required.',
      });
      expect(mockService.unlinkProvider).not.toHaveBeenCalled();
    });

    it('rejects unsupported provider with 400 INVALID_PROVIDER', async () => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .delete('/api/auth/social/twitter/link')
        .send({
          confirm: true,
          currentPassword: 'password123',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_PROVIDER',
        message: 'Unsupported social auth provider.',
      });
      expect(mockService.unlinkProvider).not.toHaveBeenCalled();
    });

    it.each([
      ['missing currentPassword', { confirm: true }],
      ['empty currentPassword', { confirm: true, currentPassword: '' }],
      ['whitespace currentPassword', { confirm: true, currentPassword: '   ' }],
      ['object currentPassword', { confirm: true, currentPassword: {} }],
    ])('rejects invalid currentPassword (%s) with 400 INVALID_TOKEN', async (_label, body) => {
      const { app, mockService } = createHarness();

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'INVALID_TOKEN',
        message: 'currentPassword is required.',
      });
      expect(mockService.unlinkProvider).not.toHaveBeenCalled();
    });
  });

  describe('service error handling and state transitions', () => {
    it('returns 401 when identity is not linked', async () => {
      const { app, mockService } = createHarness();
      mockService.unlinkProvider.mockRejectedValue(
        new SocialAuthError(
          'SOCIAL_IDENTITY_NOT_LINKED',
          'No linked Apple identity found for this account.',
        ),
      );

      const res = await request(app)
        .delete('/api/auth/social/apple/link')
        .send({
          confirm: true,
          currentPassword: 'password123',
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'SOCIAL_IDENTITY_NOT_LINKED',
        message: 'No linked Apple identity found for this account.',
      });
    });

    it('returns 401 when current password validation fails (STEP_UP_REQUIRED)', async () => {
      const { app, mockService } = createHarness();
      mockService.unlinkProvider.mockRejectedValue(
        new SocialAuthError(
          'STEP_UP_REQUIRED',
          'Current password is incorrect.',
        ),
      );

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send({
          confirm: true,
          currentPassword: 'wrongPassword',
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        error: 'STEP_UP_REQUIRED',
        message: 'Current password is incorrect.',
      });
    });

    it('returns 404 when user is not found', async () => {
      const { app, mockService } = createHarness();
      mockService.unlinkProvider.mockRejectedValue(
        new SocialAuthError('USER_NOT_FOUND', 'User does not exist.'),
      );

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send({
          confirm: true,
          currentPassword: 'password123',
        });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        error: 'USER_NOT_FOUND',
        message: 'User does not exist.',
      });
    });

    it('routes unexpected unlink failures to Express error middleware (500)', async () => {
      const { app, mockService } = createHarness();
      mockService.unlinkProvider.mockRejectedValue(new Error('Database write failure'));

      const res = await request(app)
        .delete('/api/auth/social/google/link')
        .send({
          confirm: true,
          currentPassword: 'password123',
        });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
    });
  });
});
