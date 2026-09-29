/**
 * @file src/auth/oidc/oidcRoute.test.ts
 * @description Focused behavior coverage for `createOidcRouter` and the
 * `OidcRouterDependencies` contract it consumes (see `./oidcRoute.ts`).
 *
 * The suite drives the router through a real Express app with supertest so
 * status codes, response bodies, audit side-effects and dependency calls are
 * all observable. Every collaborator is injected via `OidcRouterDependencies`,
 * so no network, database or session-store state is required.
 *
 * Covered surface:
 *  - GET  /api/auth/oidc/authorize          (400 / 404 / 302)
 *  - GET  /api/auth/oidc/callback           (400 / 401 / 404 / 200 + role mapping)
 *  - POST /api/auth/oidc/jwks/refresh       (admin gate, dual confirmation, cooldown)
 *  - POST|GET /api/auth/oidc/providers      (admin gate, secret stripping)
 *  - GET|POST /api/auth/oidc/logout         (missing / malformed token, success)
 *  - error propagation: unexpected failures reach the Express error handler,
 *    while auth-relevant failures ("Invalid"/"expired"/"mismatch") become 401s.
 */

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createOidcRouter, OidcRouterDependencies } from './oidcRoute';
import { OidcProviderRow } from './types';
import { sessionStore } from '../../lib/sessionStore';
import { AuthenticatedRequest } from '../../middleware/auth';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ISSUER = 'https://idp.example.com';
const TENANT = 'acme';
const ADMIN = { id: 'admin-1' };

function makeProvider(overrides: Partial<OidcProviderRow> = {}): OidcProviderRow {
  return {
    id: 'prov-1',
    tenant_id: TENANT,
    name: 'Acme IdP',
    issuer_url: ISSUER,
    client_id: 'client-123',
    client_secret: 'top-secret',
    scopes: 'openid profile email',
    redirect_uris: 'https://app.example.com/callback',
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeDiscovery() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  };
}

function makeClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: ISSUER,
    sub: 'user-42',
    aud: 'client-123',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: 'nonce-1',
    email: 'user@example.com',
    name: 'Test User',
    ...overrides,
  };
}

/** Minimal fake adapter exposing only the methods the router calls. */
function makeAdapter() {
  return {
    buildAuthorizeUrl: jest.fn().mockResolvedValue({
      url: `${ISSUER}/authorize?code_challenge=abc`,
      state: 'state-1',
    }),
    consumeFlowState: jest.fn().mockReturnValue({
      tenantId: TENANT,
      codeVerifier: 'verifier-1',
      nonce: 'nonce-1',
      redirectUri: 'https://app.example.com/callback',
      expiresAt: Date.now() + 60_000,
    }),
    getDiscovery: jest.fn().mockResolvedValue(makeDiscovery()),
    exchangeCode: jest.fn().mockResolvedValue({ id_token: 'signed-id-token' }),
    validateIdToken: jest.fn().mockResolvedValue(makeClaims()),
    validateLogoutToken: jest.fn().mockResolvedValue(makeClaims()),
    refreshJwks: jest.fn().mockResolvedValue(undefined),
  };
}

function makeProviderRepo(provider: OidcProviderRow | null = makeProvider()) {
  return {
    findByTenantId: jest.fn().mockResolvedValue(provider),
    findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    findAll: jest.fn().mockResolvedValue(provider ? [provider] : []),
    create: jest.fn().mockResolvedValue(makeProvider()),
  };
}

interface Harness {
  deps: OidcRouterDependencies;
  adapter: ReturnType<typeof makeAdapter>;
  providers: ReturnType<typeof makeProviderRepo>;
  auditRefresh: jest.Mock;
  app: express.Express;
}

/**
 * Build an app with deterministic, injected dependencies.
 * `overrides` replaces whole dependency slots (not individual methods) so each
 * test states exactly which collaborator deviates from the happy path.
 */
function makeHarness(overrides: Partial<OidcRouterDependencies> = {}): Harness {
  const adapter = makeAdapter();
  const providers = makeProviderRepo();
  const auditRefresh = jest.fn();

  const deps: OidcRouterDependencies = {
    oidcAdapter: adapter as unknown as OidcRouterDependencies['oidcAdapter'],
    oidcProviderRepo: providers as unknown as OidcRouterDependencies['oidcProviderRepo'],
    requireAdmin: (req: Request, _res: Response, next: NextFunction) => {
      (req as AuthenticatedRequest).user = { id: ADMIN.id } as never;
      next();
    },
    auditRefresh,
    ...overrides,
  };

  const app = express();
  app.use(express.json());
  app.use(createOidcRouter(deps));
  // Expose the error handler contract: unexpected errors must reach `next`.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  });

  return { deps, adapter, providers, auditRefresh, app };
}

// ── Router construction ─────────────────────────────────────────────────────

describe('createOidcRouter / OidcRouterDependencies', () => {
  it('returns a mountable Express router', () => {
    const { deps } = makeHarness();
    const router = createOidcRouter(deps);
    expect(typeof router).toBe('function');
    expect((router as unknown as { stack: unknown[] }).stack.length).toBeGreaterThan(0);
  });

  it('accepts the minimal dependency set (optional repos omitted)', async () => {
    const adapter = makeAdapter();
    const providers = makeProviderRepo();
    const app = express();
    app.use(
      createOidcRouter({
        oidcAdapter: adapter as unknown as OidcRouterDependencies['oidcAdapter'],
        oidcProviderRepo: providers as unknown as OidcRouterDependencies['oidcProviderRepo'],
        requireAdmin: (_req, _res, next) => next(),
      }),
    );

    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=acme');
    expect(res.status).toBe(302);
  });
});

// ── GET /api/auth/oidc/authorize ────────────────────────────────────────────

describe('GET /api/auth/oidc/authorize', () => {
  it('returns 400 when tenantId is missing', async () => {
    const { app, providers, adapter } = makeHarness();

    const res = await request(app).get('/api/auth/oidc/authorize');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Bad Request',
      message: '"tenantId" query param is required',
    });
    expect(providers.findByTenantId).not.toHaveBeenCalled();
    expect(adapter.buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('returns 404 when no provider is configured for the tenant', async () => {
    const { app } = makeHarness({
      oidcProviderRepo: makeProviderRepo(null) as unknown as OidcRouterDependencies['oidcProviderRepo'],
    });

    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=unknown');

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No OIDC provider for tenant: unknown');
  });

  it('redirects (302) to the PKCE authorize URL on success', async () => {
    const { app, adapter, providers } = makeHarness();

    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=acme');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${ISSUER}/authorize?code_challenge=abc`);
    expect(providers.findByTenantId).toHaveBeenCalledWith(TENANT);
    expect(adapter.buildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT }),
    );
  });

  it('forwards a repeated tenantId query param verbatim to the repository', async () => {
    // Express parses `?tenantId=a&tenantId=b` into an array; the route does no
    // coercion, so the repository sees exactly what the client sent.
    const { app, providers } = makeHarness();

    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=a&tenantId=b');

    expect(res.status).toBe(302);
    expect(providers.findByTenantId).toHaveBeenCalledWith(['a', 'b']);
  });

  it('propagates unexpected adapter failures to the error handler', async () => {
    const { app, adapter } = makeHarness();
    adapter.buildAuthorizeUrl.mockRejectedValue(new Error('discovery fetch failed'));

    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=acme');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('discovery fetch failed');
  });
});

// ── GET /api/auth/oidc/callback ─────────────────────────────────────────────

describe('GET /api/auth/oidc/callback', () => {
  const callback = '/api/auth/oidc/callback?code=abc&state=state-1';

  it.each([
    ['code', '/api/auth/oidc/callback?state=state-1'],
    ['state', '/api/auth/oidc/callback?code=abc'],
  ])('returns 400 when %s is missing', async (_missing, url) => {
    const { app, adapter } = makeHarness();

    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('"code" and "state" are required');
    expect(adapter.consumeFlowState).not.toHaveBeenCalled();
  });

  it('returns 401 when the flow state is unknown or expired', async () => {
    const { app, adapter } = makeHarness();
    adapter.consumeFlowState.mockImplementation(() => {
      throw new Error('Invalid or expired flow state');
    });

    const res = await request(app).get(callback);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized', message: 'Invalid or expired flow state' });
    expect(adapter.getDiscovery).not.toHaveBeenCalled();
  });

  it('returns 404 when the provider no longer exists for the flow', async () => {
    const { app } = makeHarness({
      oidcProviderRepo: makeProviderRepo(null) as unknown as OidcRouterDependencies['oidcProviderRepo'],
    });

    const res = await request(app).get(callback);

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Provider not found for this flow');
  });

  it('exchanges the code and returns the token claims on success', async () => {
    const { app, adapter, providers } = makeHarness();

    const res = await request(app).get(callback);

    expect(res.status).toBe(200);
    expect(adapter.consumeFlowState).toHaveBeenCalledWith('state-1');
    expect(providers.findByTenantId).toHaveBeenCalledWith(TENANT);
    expect(adapter.getDiscovery).toHaveBeenCalledWith(ISSUER);
    expect(adapter.exchangeCode).toHaveBeenCalledWith(
      'abc',
      expect.objectContaining({ tenantId: TENANT }),
      expect.objectContaining({ tenant_id: TENANT }),
      expect.objectContaining({ issuer: ISSUER }),
    );
    expect(adapter.validateIdToken).toHaveBeenCalledWith(
      'signed-id-token',
      expect.objectContaining({ tenant_id: TENANT }),
      expect.objectContaining({ issuer: ISSUER }),
      'nonce-1',
    );
    expect(res.body).toEqual({
      sub: 'user-42',
      email: 'user@example.com',
      name: 'Test User',
      issuer: ISSUER,
      tenantId: TENANT,
      mappedRole: undefined,
    });
  });

  it('consumes the flow state once per callback request', async () => {
    const { app, adapter } = makeHarness();

    await request(app).get(callback);
    await request(app).get(callback);

    expect(adapter.consumeFlowState).toHaveBeenCalledTimes(2);
    expect(adapter.consumeFlowState).toHaveBeenNthCalledWith(1, 'state-1');
    expect(adapter.getDiscovery).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when ID-token validation reports an expiry', async () => {
    const { app, adapter } = makeHarness();
    adapter.validateIdToken.mockRejectedValue(new Error('ID token expired'));

    const res = await request(app).get(callback);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('ID token expired');
  });

  it('returns 401 on a nonce mismatch', async () => {
    const { app, adapter } = makeHarness();
    adapter.validateIdToken.mockRejectedValue(new Error('nonce mismatch'));

    const res = await request(app).get(callback);

    expect(res.status).toBe(401);
  });

  it('propagates unrecognised failures to the error handler', async () => {
    const { app, adapter } = makeHarness();
    adapter.exchangeCode.mockRejectedValue(new Error('token endpoint unreachable'));

    const res = await request(app).get(callback);

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('token endpoint unreachable');
  });

  it('maps the first matching group claim to a Revora role', async () => {
    const oidcGroupMappingRepo = {
      findByTenantId: jest.fn().mockResolvedValue([
        { id: 'm-1', tenant_id: TENANT, claim_group: 'other', revora_role: 'startup', created_at: new Date() },
        { id: 'm-2', tenant_id: TENANT, claim_group: 'investors', revora_role: 'investor', created_at: new Date() },
      ]),
    } as unknown as OidcRouterDependencies['oidcGroupMappingRepo'];
    const { app, adapter } = makeHarness({ oidcGroupMappingRepo });
    adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['investors'] }));

    const res = await request(app).get(callback);

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBe('investor');
    expect(oidcGroupMappingRepo!.findByTenantId).toHaveBeenCalledWith(TENANT);
  });

  it('leaves mappedRole undefined when no group claim matches', async () => {
    const oidcGroupMappingRepo = {
      findByTenantId: jest.fn().mockResolvedValue([
        { id: 'm-1', tenant_id: TENANT, claim_group: 'eng', revora_role: 'startup', created_at: new Date() },
      ]),
    } as unknown as OidcRouterDependencies['oidcGroupMappingRepo'];
    const { app, adapter } = makeHarness({ oidcGroupMappingRepo });
    adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['sales'] }));

    const res = await request(app).get(callback);

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBeUndefined();
  });

  it('skips group lookups when no mappings repository is configured', async () => {
    const { app, adapter } = makeHarness();
    adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['investors'] }));

    const res = await request(app).get(callback);

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBeUndefined();
  });

  it('ignores a non-array groups claim', async () => {
    const oidcGroupMappingRepo = {
      findByTenantId: jest.fn().mockResolvedValue([]),
    } as unknown as OidcRouterDependencies['oidcGroupMappingRepo'];
    const { app, adapter } = makeHarness({ oidcGroupMappingRepo });
    adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: 'investors' }));

    const res = await request(app).get(callback);

    expect(res.status).toBe(200);
    expect(oidcGroupMappingRepo!.findByTenantId).not.toHaveBeenCalled();
  });

  describe('claim-change auditing and role sync', () => {
    const userRepo = {
      findByEmail: jest.fn(),
      updateUser: jest.fn().mockResolvedValue({}),
    } as unknown as OidcRouterDependencies['userRepo'];
    const auditLogRepo = {
      createAuditLog: jest.fn().mockResolvedValue({}),
    } as unknown as OidcRouterDependencies['auditLogRepo'];

    beforeEach(() => {
      (userRepo!.findByEmail as jest.Mock).mockReset();
      (userRepo!.updateUser as jest.Mock).mockReset().mockResolvedValue({});
      (auditLogRepo!.createAuditLog as jest.Mock).mockReset().mockResolvedValue({});
    });

    function harnessWithRepos() {
      return makeHarness({ userRepo, auditLogRepo });
    }

    it('audits and persists group changes for a known user', async () => {
      const { app, adapter } = harnessWithRepos();
      (userRepo!.findByEmail as jest.Mock).mockResolvedValue({
        id: 'user-42',
        email: 'user@example.com',
        last_oidc_groups: ['old-group'],
      });
      adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['new-group'] }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(auditLogRepo!.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-42',
          action: 'oidc.claim.changed',
          details: JSON.stringify({ old_groups: ['old-group'], new_groups: ['new-group'] }),
        }),
      );
      expect(userRepo!.updateUser).toHaveBeenCalledWith({
        id: 'user-42',
        last_oidc_groups: ['new-group'],
      });
    });

    it('is a no-op for unchanged group claims', async () => {
      const { app, adapter } = harnessWithRepos();
      (userRepo!.findByEmail as jest.Mock).mockResolvedValue({
        id: 'user-42',
        email: 'user@example.com',
        last_oidc_groups: ['eng', 'investors'],
      });
      adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['investors', 'eng'] }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(auditLogRepo!.createAuditLog).not.toHaveBeenCalled();
      expect(userRepo!.updateUser).not.toHaveBeenCalled();
    });

    it('syncs only the role when groups are unchanged but a mapping matches', async () => {
      const oidcGroupMappingRepo = {
        findByTenantId: jest.fn().mockResolvedValue([
          { id: 'm-1', tenant_id: TENANT, claim_group: 'eng', revora_role: 'startup', created_at: new Date() },
        ]),
      } as unknown as OidcRouterDependencies['oidcGroupMappingRepo'];
      const { app, adapter } = makeHarness({ userRepo, auditLogRepo, oidcGroupMappingRepo });
      (userRepo!.findByEmail as jest.Mock).mockResolvedValue({
        id: 'user-42',
        email: 'user@example.com',
        last_oidc_groups: ['eng'],
      });
      adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['eng'] }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(res.body.mappedRole).toBe('startup');
      expect(auditLogRepo!.createAuditLog).not.toHaveBeenCalled();
      expect(userRepo!.updateUser).toHaveBeenCalledWith({ id: 'user-42', role: 'startup' });
    });

    it('does not touch user state when both repositories are absent', async () => {
      const { app, adapter } = makeHarness();
      adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['new-group'] }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(userRepo!.findByEmail).not.toHaveBeenCalled();
      expect(auditLogRepo!.createAuditLog).not.toHaveBeenCalled();
    });

    it('does not update an unknown email', async () => {
      const { app, adapter } = harnessWithRepos();
      (userRepo!.findByEmail as jest.Mock).mockResolvedValue(null);
      adapter.validateIdToken.mockResolvedValue(makeClaims({ groups: ['new-group'] }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(userRepo!.updateUser).not.toHaveBeenCalled();
    });

    it('returns 200 even when the email claim is absent', async () => {
      const { app, adapter } = harnessWithRepos();
      adapter.validateIdToken.mockResolvedValue(makeClaims({ email: undefined }));

      const res = await request(app).get(callback);

      expect(res.status).toBe(200);
      expect(userRepo!.findByEmail).not.toHaveBeenCalled();
    });
  });
});

// ── POST /api/auth/oidc/jwks/refresh ────────────────────────────────────────

describe('POST /api/auth/oidc/jwks/refresh', () => {
  const path = '/api/auth/oidc/jwks/refresh';
  const confirm = (agent: request.Test) => agent.set('x-revora-oidc-jwks-confirmation', 'true');

  it('denies unauthenticated callers via the requireAdmin dependency', async () => {
    const { app, adapter, auditRefresh } = makeHarness({
      requireAdmin: (_req, res) => {
        res.status(403).json({ error: 'Forbidden' });
      },
    });

    const res = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(403);
    expect(adapter.refreshJwks).not.toHaveBeenCalled();
    expect(auditRefresh).not.toHaveBeenCalled();
  });

  it('is also mounted without the /api prefix', async () => {
    const { app, adapter } = makeHarness();

    const res = await confirm(request(app).post('/auth/oidc/jwks/refresh')).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(200);
    expect(adapter.refreshJwks).toHaveBeenCalledWith(ISSUER);
  });

  it('returns 400 and audits a blocked attempt when issuerUrl is missing', async () => {
    const { app, adapter, auditRefresh } = makeHarness();

    const res = await confirm(request(app).post(path)).send({ confirmation: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad Request', message: 'issuerUrl is required' });
    expect(adapter.refreshJwks).not.toHaveBeenCalled();
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'jwks_refresh',
        reason: 'missing_issuer',
        status: 'blocked',
        actorId: ADMIN.id,
      }),
    );
  });

  it('returns 400 when only the body confirmation flag is present', async () => {
    const { app, adapter, auditRefresh } = makeHarness();

    const res = await request(app)
      .post(path)
      .send({ confirmation: true, issuerUrl: ISSUER });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Dual confirmation is required');
    expect(adapter.refreshJwks).not.toHaveBeenCalled();
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_confirmation', status: 'blocked' }),
    );
  });

  it('returns 400 when only the header confirmation flag is present', async () => {
    const { app, adapter, auditRefresh } = makeHarness();

    const res = await confirm(request(app).post(path)).send({
      confirmation: false,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Dual confirmation is required');
    expect(adapter.refreshJwks).not.toHaveBeenCalled();
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_confirmation', status: 'blocked' }),
    );
  });

  it('refreshes JWKS when both confirmations are present', async () => {
    const { app, adapter, auditRefresh } = makeHarness();

    const before = Date.now();
    const res = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.issuerUrl).toBe(ISSUER);
    expect(new Date(res.body.refreshedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(adapter.refreshJwks).toHaveBeenCalledWith(ISSUER);
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'jwks_refresh', status: 'success', issuerUrl: ISSUER }),
    );
  });

  it('accepts the string form of the body confirmation flag', async () => {
    const { app, adapter } = makeHarness();

    const res = await confirm(request(app).post(path)).send({
      confirmation: 'true',
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(200);
    expect(adapter.refreshJwks).toHaveBeenCalledTimes(1);
  });

  it('rate-limits a repeated refresh for the same actor and issuer', async () => {
    const { app, adapter, auditRefresh } = makeHarness();

    const first = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });
    const second = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.message).toBe('JWKS refresh is rate-limited for this actor');
    expect(adapter.refreshJwks).toHaveBeenCalledTimes(1);
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'rate_limited', status: 'blocked' }),
    );
  });

  it('tracks the cooldown per issuer', async () => {
    const { app, adapter } = makeHarness();

    const first = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });
    const other = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: 'https://other-idp.example.com',
    });

    expect(first.status).toBe(200);
    expect(other.status).toBe(200);
    expect(adapter.refreshJwks).toHaveBeenCalledTimes(2);
    expect(adapter.refreshJwks).toHaveBeenLastCalledWith('https://other-idp.example.com');
  });

  it('falls back to the request IP when no authenticated actor is attached', async () => {
    const { app, adapter } = makeHarness({
      requireAdmin: (_req, _res, next) => next(),
    });

    const res = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(200);
    expect(adapter.refreshJwks).toHaveBeenCalledTimes(1);
  });

  it('propagates adapter failures to the error handler without auditing success', async () => {
    const { app, adapter, auditRefresh } = makeHarness();
    adapter.refreshJwks.mockRejectedValue(new Error('jwks endpoint unavailable'));

    const res = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('jwks endpoint unavailable');
    expect(auditRefresh).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success' }),
    );
  });

  it('succeeds when the optional auditRefresh hook is not supplied', async () => {
    const { app, adapter } = makeHarness({ auditRefresh: undefined });

    const res = await confirm(request(app).post(path)).send({
      confirmation: true,
      issuerUrl: ISSUER,
    });

    expect(res.status).toBe(200);
    expect(adapter.refreshJwks).toHaveBeenCalledWith(ISSUER);
  });
});

// ── Admin provider management ───────────────────────────────────────────────

describe('admin OIDC provider routes', () => {
  it('returns 401 from requireAdmin before touching the repository', async () => {
    const { app, providers } = makeHarness({
      requireAdmin: (_req, res) => {
        res.status(401).json({ error: 'Unauthorized' });
      },
    });

    const res = await request(app)
      .post('/api/auth/oidc/providers')
      .send({ tenantId: TENANT, name: 'Acme', issuerUrl: ISSUER, clientId: 'c', redirectUris: 'u' });

    expect(res.status).toBe(401);
    expect(providers.create).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', { name: 'Acme', issuerUrl: ISSUER, clientId: 'c', redirectUris: 'u' }],
    ['name', { tenantId: TENANT, issuerUrl: ISSUER, clientId: 'c', redirectUris: 'u' }],
    ['issuerUrl', { tenantId: TENANT, name: 'Acme', clientId: 'c', redirectUris: 'u' }],
    ['clientId', { tenantId: TENANT, name: 'Acme', issuerUrl: ISSUER, redirectUris: 'u' }],
    ['redirectUris', { tenantId: TENANT, name: 'Acme', issuerUrl: ISSUER, clientId: 'c' }],
  ])('returns 400 when %s is missing', async (_field, body) => {
    const { app, providers } = makeHarness();

    const res = await request(app).post('/api/auth/oidc/providers').send(body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'tenantId, name, issuerUrl, clientId, redirectUris are required',
    );
    expect(providers.create).not.toHaveBeenCalled();
  });

  it('creates a provider and never leaks the client secret', async () => {
    const providers = makeProviderRepo();
    providers.create.mockResolvedValue(makeProvider({ client_secret: 'never-leak-me' }));
    const { app } = makeHarness({
      oidcProviderRepo: providers as unknown as OidcRouterDependencies['oidcProviderRepo'],
    });

    const res = await request(app).post('/api/auth/oidc/providers').send({
      tenantId: TENANT,
      name: 'Acme IdP',
      issuerUrl: ISSUER,
      clientId: 'client-123',
      clientSecret: 'never-leak-me',
      redirectUris: 'https://app.example.com/callback',
    });

    expect(res.status).toBe(201);
    expect(res.body.client_secret).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('never-leak-me');
    expect(providers.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, clientSecret: 'never-leak-me' }),
    );
  });

  it('lists providers with secrets stripped', async () => {
    const { app } = makeHarness();

    const res = await request(app).get('/api/auth/oidc/providers');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].client_secret).toBeUndefined();
    expect(res.body[0].tenant_id).toBe(TENANT);
    expect(JSON.stringify(res.body)).not.toContain('top-secret');
  });

  it('propagates repository failures to the error handler', async () => {
    const { app, providers } = makeHarness();
    providers.findAll.mockRejectedValue(new Error('db down'));

    const res = await request(app).get('/api/auth/oidc/providers');

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('db down');
  });

  it('propagates create failures to the error handler', async () => {
    const { app, providers } = makeHarness();
    providers.create.mockRejectedValue(new Error('unique violation'));

    const res = await request(app).post('/api/auth/oidc/providers').send({
      tenantId: TENANT,
      name: 'Acme IdP',
      issuerUrl: ISSUER,
      clientId: 'client-123',
      redirectUris: 'https://app.example.com/callback',
    });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('unique violation');
  });
});

// ── Logout routes (router-level wiring) ─────────────────────────────────────

describe('OIDC logout routes', () => {
  const base64url = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  it('returns 400 when no logout_token is supplied', async () => {
    const { app } = makeHarness();

    const res = await request(app).get('/auth/oidc/logout');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('logout_token is required');
  });

  it('returns 400 for a malformed logout token', async () => {
    const { app } = makeHarness();

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: 'not.a.valid.jwt' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed logout token');
  });

  it('returns 400 when the logout token has no issuer', async () => {
    const { app, providers } = makeHarness();

    const token = `${base64url({ alg: 'RS256', kid: 'k1' })}.${base64url({ sub: 'user-42' })}.sig`;

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Logout token missing issuer');
    expect(providers.findByIssuerUrl).not.toHaveBeenCalled();
  });

  it('returns 400 when no provider matches the logout issuer', async () => {
    const { app } = makeHarness({
      oidcProviderRepo: makeProviderRepo(null) as unknown as OidcRouterDependencies['oidcProviderRepo'],
    });

    const token = `${base64url({ alg: 'RS256', kid: 'k1' })}.${base64url({ iss: ISSUER, sub: 'user-42' })}.sig`;

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Provider not found for issuer');
  });

  it.each(['Logout token replayed', 'Logout token signature mismatch']) (
    'returns 400 when validation fails with "%s"',
    async (message) => {
      const { app, adapter } = makeHarness();
      adapter.validateLogoutToken.mockRejectedValue(new Error(message));

      const token = `${base64url({ alg: 'RS256', kid: 'k1' })}.${base64url({ iss: ISSUER, sub: 'user-42' })}.sig`;

      const res = await request(app)
        .post('/api/auth/oidc/logout')
        .send({ logout_token: token });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    },
  );

  it('propagates unexpected logout failures to the error handler', async () => {
    const { app, adapter } = makeHarness();
    adapter.getDiscovery.mockRejectedValue(new Error('idp unreachable'));

    const token = `${base64url({ alg: 'RS256', kid: 'k1' })}.${base64url({ iss: ISSUER, sub: 'user-42' })}.sig`;

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe('idp unreachable');
  });

  it('clears all sessions for the subject on a valid logout token', async () => {
    const { app, adapter, providers } = makeHarness();
    const deleteSpy = jest
      .spyOn(sessionStore, 'deleteAllForUser')
      .mockResolvedValue(undefined);

    const token = `${base64url({ alg: 'RS256', kid: 'k1' })}.${base64url({ iss: ISSUER, sub: 'user-42' })}.sig`;

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Logged out successfully' });
    expect(providers.findByIssuerUrl).toHaveBeenCalledWith(ISSUER);
    expect(adapter.validateLogoutToken).toHaveBeenCalledWith(
      token,
      expect.objectContaining({ tenant_id: TENANT }),
      expect.objectContaining({ issuer: ISSUER }),
    );
    expect(deleteSpy).toHaveBeenCalledWith('user-42');

    deleteSpy.mockRestore();
  });
});
