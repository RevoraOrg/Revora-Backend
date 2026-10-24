import { parseMoneyString } from "./index";
import supertest from "supertest";
import { createApp } from "./index";
import { issueToken } from "./lib/jwt";
import { hashSessionToken } from "./auth/session";

describe("src/index.ts", () => {
  describe("distribution and payout routes", () => {
    const jwtSecret = "test-secret-for-distribution-route-tests";
    const issuerId = "issuer-test";
    const investorId = "investor-test";

    beforeAll(() => {
      process.env.JWT_SECRET = jwtSecret;
    });

    function appWithFakes() {
      const sessions = new Map<string, { id: string; user_id: string; token_hash: string; expires_at: Date }>();
      const tokenFor = (userId: string, role: string) => {
        const sessionId = `${role}-session`;
        const token = issueToken({
          subject: userId,
          additionalPayload: { sid: sessionId, role },
        });
        sessions.set(sessionId, {
          id: sessionId,
          user_id: userId,
          token_hash: hashSessionToken(token),
          expires_at: new Date(Date.now() + 60_000),
        });
        return token;
      };

      const issuerToken = tokenFor(issuerId, "startup");
      const investorToken = tokenFor(investorId, "investor");
      const app = createApp({
        sessionRepository: {
          findById: async (id) => sessions.get(id) ?? null,
        },
        distributionOfferingRepo: {
          getById: async (id) =>
            id === "offering-1"
              ? { id, issuer_id: issuerId }
              : null,
        },
        distributionEngine: {
          distribute: jest.fn(),
          previewRun: jest.fn().mockResolvedValue({
            preview_id: "preview-1",
            offering_id: "offering-1",
            period_id: "2026-01",
            revenue_amount: "100",
            computed_at: "2026-01-31T00:00:00.000Z",
            investor_count: 1,
            projections: [{ investor_id: investorId, amount: "100.00" }],
          }),
        },
        payoutRepo: {
          listPayoutsByInvestor: async (id) =>
            id === investorId
              ? [{
                  id: "payout-1",
                  distribution_run_id: "run-1",
                  investor_id: investorId,
                  amount: "100.00",
                  status: "processed",
                  created_at: new Date("2026-01-31T00:00:00.000Z"),
                  updated_at: new Date("2026-01-31T00:00:00.000Z"),
                }]
              : [],
        },
      });

      return { app, issuerToken, investorToken };
    }

    it("serves a distribution preview to the authenticated offering issuer", async () => {
      const { app, issuerToken } = appWithFakes();

      const response = await supertest(app)
        .post("/api/v1/offerings/offering-1/distribute/preview")
        .set("Authorization", `Bearer ${issuerToken}`)
        .send({
          revenue_amount: "100",
          period: {
            id: "2026-01",
            start: "2026-01-01T00:00:00.000Z",
            end: "2026-01-31T00:00:00.000Z",
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.preview_id).toBe("preview-1");
    });

    it("requires a valid session-backed token for distribution previews", async () => {
      const { app } = appWithFakes();

      const response = await supertest(app)
        .post("/api/v1/offerings/offering-1/distribute/preview")
        .send({
          revenue_amount: "100",
          period: {
            start: "2026-01-01T00:00:00.000Z",
            end: "2026-01-31T00:00:00.000Z",
          },
        });

      expect(response.status).toBe(401);
    });

    it("requires a valid session-backed token to list payouts", async () => {
      const { app } = appWithFakes();

      const response = await supertest(app).get("/api/v1/investments/payouts");

      expect(response.status).toBe(401);
    });

    it("lists only the authenticated investor's payouts", async () => {
      const { app, investorToken } = appWithFakes();

      const response = await supertest(app)
        .get("/api/v1/investments/payouts")
        .set("Authorization", `Bearer ${investorToken}`);

      expect(response.status).toBe(200);
      expect(response.body.payouts).toHaveLength(1);
      expect(response.body.payouts[0].investor_id).toBe(investorId);
    });
  });

  describe("parseMoneyString", () => {
    it("should return null for non-string values", () => {
      // Evidence: if (typeof value !== "string") return null;
      expect(parseMoneyString(123)).toBeNull();
      expect(parseMoneyString(undefined)).toBeNull();
      expect(parseMoneyString(null)).toBeNull();
      expect(parseMoneyString({})).toBeNull();
    });

    it('returns null for invalid strings (regex failure)', () => {
      expect(parseMoneyString('')).toBeNull();
      expect(parseMoneyString('not-a-number')).toBeNull();
      expect(parseMoneyString('01')).toBeNull();
      expect(parseMoneyString('123.456')).toBeNull();
      expect(parseMoneyString('1234567890123')).toBeNull();
      expect(parseMoneyString('-100')).toBeNull();
      expect(parseMoneyString(' 100 ')).toBeNull();
    });

    it('returns null if Number.isFinite fails', () => {
      const originalTest = RegExp.prototype.test;
      RegExp.prototype.test = function (str: string) {
        if (str === 'Infinity' || str === 'NaN') return true;
        return originalTest.call(this, str);
      };
      try {
        expect(parseMoneyString('Infinity')).toBeNull();
        expect(parseMoneyString('NaN')).toBeNull();
      } finally {
        RegExp.prototype.test = originalTest;
      }
    });

    it('parses valid money strings correctly', () => {
      expect(parseMoneyString('0')).toBe(0);
      expect(parseMoneyString('10')).toBe(10);
      expect(parseMoneyString('100.5')).toBe(100.5);
      expect(parseMoneyString('12345.67')).toBe(12345.67);
      expect(parseMoneyString('999999999999.99')).toBe(999999999999.99);
    });
  });
});

// =============================================================================
// Section 2 – Auth route mount verification (core of issue #1270)
//
// These tests assert that auth endpoints are reachable (not 404) from the
// production createApp() factory. Inputs are deliberately invalid so the
// handlers short-circuit without touching the database.
// =============================================================================

describe('Auth route wiring — createApp() in src/index.ts', () => {
  // Lazily build the app once per describe block.
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    app = createApp();
  });

  // ── POST /api/auth/login ──────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('returns 400 for an empty body (not 404)', async () => {
      // Acceptance criterion: empty body must yield 400, not 404.
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({})
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('returns 400 when only email is supplied', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: 'user@example.com' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('returns 400 when only password is supplied', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ password: 's3cr3t' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(400);
    });

    it('returns 400 for a missing Content-Type body', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/login`);

      // Handler receives an empty body; must still return 400 not 404.
      expect(res.status).toBe(400);
    });
  });

  // ── POST /api/auth/refresh ────────────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('is mounted — returns non-404 for an empty body', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/refresh`)
        .send({})
        .set('Content-Type', 'application/json');

      // The refresh handler rejects missing/invalid tokens. Any status except
      // 404 confirms the route exists.
      expect(res.status).not.toBe(404);
    });

    it('returns 401 for an obviously invalid refresh token', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/refresh`)
        .send({ refreshToken: 'not-a-jwt' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('is mounted — returns 401 without a bearer token (not 404)', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/logout`);

      expect(res.status).toBe(401);
    });

    it('returns 401 for a malformed bearer token', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/logout`)
        .set('Authorization', 'Bearer not-a-real-jwt');

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/v1/users/me/change-password ────────────────────────────────

  describe('POST /api/v1/users/me/change-password', () => {
    it('is mounted — returns 401 without a bearer token (not 404)', async () => {
      const res = await request(app)
        .post(`${API_V1}/users/me/change-password`)
        .send({ currentPassword: 'old', newPassword: 'new' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });
  });

  // ── PATCH /api/v1/users/me/password (alias) ───────────────────────────────

  describe('PATCH /api/v1/users/me/password', () => {
    it('is mounted — returns 401 without a bearer token (not 404)', async () => {
      const res = await request(app)
        .patch(`${API_V1}/users/me/password`)
        .send({ currentPassword: 'old', newPassword: 'new' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/auth/social/:provider/login ────────────────────────────────

  describe('POST /api/auth/social/:provider/login', () => {
    it('is mounted for google provider — returns non-404', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/social/google/login`)
        .send({ idToken: 'fake' })
        .set('Content-Type', 'application/json');

      expect(res.status).not.toBe(404);
    });

    it('is mounted for apple provider — returns non-404', async () => {
      const res = await request(app)
        .post(`${API_AUTH}/social/apple/login`)
        .send({ idToken: 'fake' })
        .set('Content-Type', 'application/json');

      expect(res.status).not.toBe(404);
    });
  });
});

// =============================================================================
// Section 3 – Auth e2e flow
//
// Tests a complete login → protected-route → refresh → logout cycle using
// a real JWT issued by the LoginService with a seeded in-memory user.
//
// Because the auth services construct their own DB adapters via the pool mock,
// we intercept at the LoginService layer by mocking the UserRepository and
// SessionRepository implementations. The JWT stack is left real so that tokens
// issued by login can actually be verified by createRequireAuth.
// =============================================================================

describe('Auth e2e flow', () => {
  // ── Fake user store shared between login and session checks ──────────────

  const TEST_EMAIL = 'e2e-user@revora.test';
  const TEST_PASSWORD = 'ValidP@ssw0rd!';
  const TEST_USER_ID = 'e2e-user-1';

  // We reuse the sha256 that LoginService uses internally.
  const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

  const fakeUser = {
    id: TEST_USER_ID,
    email: TEST_EMAIL,
    role: 'investor' as const,
    password_hash: sha256(TEST_PASSWORD),
  };

  // Session store: keyed by session_id.
  const sessionStore = new Map<string, {
    user_id: string;
    token_hash: string;
    expires_at: Date;
    revoked_at?: Date;
    parent_id?: string;
  }>();

  // ── Wire mocks for UserRepository and SessionRepository ──────────────────

  beforeAll(() => {
    const { UserRepository } = require('./db/repositories/userRepository');
    const { SessionRepository } = require('./db/repositories/sessionRepository');

    // Stub UserRepository methods used by LoginService and ChangePasswordService
    UserRepository.prototype.findByEmail = jest.fn().mockImplementation(
      async (email: string) => (email === TEST_EMAIL ? fakeUser : null),
    );
    UserRepository.prototype.findById = jest.fn().mockImplementation(
      async (id: string) => (id === TEST_USER_ID ? fakeUser : null),
    );
    UserRepository.prototype.updatePasswordHash = jest.fn().mockResolvedValue(undefined);

    // Stub SessionRepository methods
    SessionRepository.prototype.createSession = jest.fn().mockImplementation(
      async (input: { id: string; user_id: string; token_hash: string; expires_at: Date; parent_id?: string }) => {
        sessionStore.set(input.id, {
          user_id: input.user_id,
          token_hash: input.token_hash,
          expires_at: input.expires_at,
          parent_id: input.parent_id,
        });
      },
    );

    SessionRepository.prototype.findById = jest.fn().mockImplementation(
      async (id: string) => {
        const s = sessionStore.get(id);
        if (!s || s.revoked_at) return null;
        return { id, ...s };
      },
    );

    SessionRepository.prototype.findByParentId = jest.fn().mockImplementation(
      async (parentId: string) => {
        for (const [id, s] of sessionStore.entries()) {
          if (s.parent_id === parentId) return { id, ...s };
        }
        return null;
      },
    );

    SessionRepository.prototype.revokeSessionAndDescendants = jest.fn().mockImplementation(
      async (id: string) => {
        const visited = new Set<string>();
        const toRevoke = [id];
        while (toRevoke.length) {
          const current = toRevoke.pop()!;
          if (visited.has(current)) continue;
          visited.add(current);
          const session = sessionStore.get(current);
          if (session) {
            session.revoked_at = new Date();
            // Find children
            for (const [childId, s] of sessionStore.entries()) {
              if (s.parent_id === current) toRevoke.push(childId);
            }
          }
        }
      },
    );

    SessionRepository.prototype.revokeById = jest.fn().mockImplementation(
      async (id: string) => {
        const s = sessionStore.get(id);
        if (s) s.revoked_at = new Date();
      },
    );
  });

  beforeEach(() => {
    sessionStore.clear();
    jest.clearAllMocks();
    // Re-register stubs after clearAllMocks wipes mock implementations.
    const { UserRepository } = require('./db/repositories/userRepository');
    const { SessionRepository } = require('./db/repositories/sessionRepository');

    UserRepository.prototype.findByEmail = jest.fn().mockImplementation(
      async (email: string) => (email === TEST_EMAIL ? fakeUser : null),
    );
    UserRepository.prototype.findById = jest.fn().mockImplementation(
      async (id: string) => (id === TEST_USER_ID ? fakeUser : null),
    );
    UserRepository.prototype.updatePasswordHash = jest.fn().mockResolvedValue(undefined);

    SessionRepository.prototype.createSession = jest.fn().mockImplementation(
      async (input: { id: string; user_id: string; token_hash: string; expires_at: Date; parent_id?: string }) => {
        sessionStore.set(input.id, {
          user_id: input.user_id,
          token_hash: input.token_hash,
          expires_at: input.expires_at,
          parent_id: input.parent_id,
        });
      },
    );

    SessionRepository.prototype.findById = jest.fn().mockImplementation(
      async (id: string) => {
        const s = sessionStore.get(id);
        if (!s || s.revoked_at) return null;
        return { id, ...s };
      },
    );

    SessionRepository.prototype.findByParentId = jest.fn().mockImplementation(
      async (parentId: string) => {
        for (const [id, s] of sessionStore.entries()) {
          if (s.parent_id === parentId) return { id, ...s };
        }
        return null;
      },
    );

    SessionRepository.prototype.revokeSessionAndDescendants = jest.fn().mockImplementation(
      async (id: string) => {
        const visited = new Set<string>();
        const toRevoke = [id];
        while (toRevoke.length) {
          const current = toRevoke.pop()!;
          if (visited.has(current)) continue;
          visited.add(current);
          const session = sessionStore.get(current);
          if (session) {
            session.revoked_at = new Date();
            for (const [childId, s] of sessionStore.entries()) {
              if (s.parent_id === current) toRevoke.push(childId);
            }
          }
        }
      },
    );

    SessionRepository.prototype.revokeById = jest.fn().mockImplementation(
      async (id: string) => {
        const s = sessionStore.get(id);
        if (s) s.revoked_at = new Date();
      },
    );
  });

  // ── Login ─────────────────────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('returns 200 with access and refresh tokens for valid credentials', async () => {
      const app = createApp();
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(typeof res.body.accessToken).toBe('string');
      expect(typeof res.body.refreshToken).toBe('string');
    });

    it('returns 401 for wrong password', async () => {
      const app = createApp();
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: 'wrong-password' })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });

    it('returns 401 for unknown email', async () => {
      const app = createApp();
      const res = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: 'ghost@example.com', password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(401);
    });

    it('creates a session in the session store on success', async () => {
      const app = createApp();
      await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(sessionStore.size).toBeGreaterThan(0);
    });
  });

  // ── Protected route access with access token ──────────────────────────────

  describe('Protected route with access token from login', () => {
    it('returns non-401 on a protected route when bearing the access token', async () => {
      const app = createApp();

      // Step 1: login
      const loginRes = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(loginRes.status).toBe(200);
      const { accessToken } = loginRes.body as { accessToken: string; refreshToken: string };

      // Step 2: call a protected route (change-password) with the token.
      // We send an invalid body intentionally so we get 400 (auth passed) not
      // a domain error, proving the token was accepted by the auth middleware.
      const protectedRes = await request(app)
        .post(`${API_V1}/users/me/change-password`)
        .send({})
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${accessToken}`);

      // 400 = auth middleware passed, body validation failed — token works.
      // NOT 401 (auth rejected) and NOT 404 (route missing).
      expect(protectedRes.status).not.toBe(404);
      expect(protectedRes.status).not.toBe(401);
    });
  });

  // ── Refresh ───────────────────────────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('issues a new token pair for a valid refresh token', async () => {
      const app = createApp();

      const loginRes = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(loginRes.status).toBe(200);
      const { refreshToken } = loginRes.body as { accessToken: string; refreshToken: string };

      const refreshRes = await request(app)
        .post(`${API_AUTH}/refresh`)
        .send({ refreshToken })
        .set('Content-Type', 'application/json');

      expect(refreshRes.status).toBe(200);
      expect(refreshRes.body).toHaveProperty('accessToken');
      expect(refreshRes.body).toHaveProperty('refreshToken');
      // Rotation: new refresh token must differ from the original.
      expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
    });

    it('rejects a refresh token that has already been rotated (reuse detection)', async () => {
      const app = createApp();

      const loginRes = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      const { refreshToken } = loginRes.body as { accessToken: string; refreshToken: string };

      // First refresh — should succeed.
      const firstRefresh = await request(app)
        .post(`${API_AUTH}/refresh`)
        .send({ refreshToken })
        .set('Content-Type', 'application/json');
      expect(firstRefresh.status).toBe(200);

      // Second use of the *original* refresh token — reuse detected → 401.
      const reusedRefresh = await request(app)
        .post(`${API_AUTH}/refresh`)
        .send({ refreshToken })
        .set('Content-Type', 'application/json');
      expect(reusedRefresh.status).toBe(401);
    });
  });

  // ── Logout ────────────────────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('returns 204 and revokes the session', async () => {
      const app = createApp();

      // Login to get a token.
      const loginRes = await request(app)
        .post(`${API_AUTH}/login`)
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .set('Content-Type', 'application/json');

      expect(loginRes.status).toBe(200);
      const { accessToken } = loginRes.body as { accessToken: string; refreshToken: string };

      // Logout.
      const logoutRes = await request(app)
        .post(`${API_AUTH}/logout`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(logoutRes.status).toBe(204);
    });

    it('returns 401 when no bearer token is provided', async () => {
      const app = createApp();
      const res = await request(app).post(`${API_AUTH}/logout`);
      expect(res.status).toBe(401);
    });
  });
});

// =============================================================================
// Section 4 – Route enumeration
//
// Verifies that enumerateRoutes() lists the auth routes, satisfying the
// acceptance criterion "route enumeration lists the auth routes".
// =============================================================================

describe('Route enumerator lists auth routes', () => {
  let routes: Array<{ path: string; method: string }>;

  beforeAll(() => {
    const app = createApp();
    routes = enumerateRoutes(app);
  });

  const authPaths = [
    { method: 'POST', path: `${API_AUTH}/login` },
    { method: 'POST', path: `${API_AUTH}/refresh` },
    { method: 'POST', path: `${API_AUTH}/logout` },
    { method: 'POST', path: `${API_V1}/users/me/change-password` },
    { method: 'PATCH', path: `${API_V1}/users/me/password` },
  ];

  it.each(authPaths)(
    'includes $method $path',
    ({ method, path }) => {
      const found = routes.some(
        (r) => r.method === method && r.path === path,
      );
      expect(found).toBe(true);
    },
  );

  it('lists social login routes for at least one provider path', () => {
    const socialPaths = routes.filter(
      (r) => r.method === 'POST' && r.path.includes('/api/auth/social/'),
    );
    expect(socialPaths.length).toBeGreaterThan(0);
  });
});
