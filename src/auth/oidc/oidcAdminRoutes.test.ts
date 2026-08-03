import express from 'express';
import request from 'supertest';
import { createOidcRouter } from './oidcRoute';

/**
 * Coverage + behavior tests for the pre-existing OIDC admin/authorize/logout
 * routes. Kept separate from the refresh dual-control tests in oidc.test.ts.
 */

const provider = {
  id: 'uuid-1',
  tenant_id: 'acme',
  name: 'Acme IdP',
  issuer_url: 'https://idp.example.com',
  client_id: 'client-123',
  client_secret: 'super-secret',
  scopes: 'openid profile email',
  redirect_uris: 'https://app.example.com/callback',
  enabled: true,
  created_at: new Date(),
};

const discovery = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
};

const requireAdmin = (req: any, _res: any, next: () => void) => {
  req.user = { id: 'admin-1' };
  next();
};

function makeApp(overrides: {
  oidcAdapter?: Record<string, any>;
  oidcProviderRepo?: Record<string, any>;
  userRepo?: Record<string, any>;
  oidcGroupMappingRepo?: Record<string, any>;
  auditLogRepo?: Record<string, any>;
} = {}) {
  const oidcAdapter = {
    consumeFlowState: jest.fn().mockReturnValue({ tenantId: 'acme' }),
    getDiscovery: jest.fn().mockResolvedValue(discovery),
    exchangeCode: jest.fn().mockResolvedValue({ id_token: 'token' }),
    validateIdToken: jest.fn().mockResolvedValue({ sub: 'user-42', email: 'u@example.com' }),
    validateLogoutToken: jest.fn(),
    buildAuthorizeUrl: jest.fn(),
    ...overrides.oidcAdapter,
  } as any;
  const oidcProviderRepo = {
    findByTenantId: jest.fn().mockResolvedValue(provider),
    findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    findAll: jest.fn().mockResolvedValue([provider]),
    create: jest.fn().mockResolvedValue(provider),
    ...overrides.oidcProviderRepo,
  } as any;
  const userRepo = {
    findByEmail: jest.fn(),
    updateUser: jest.fn(),
    ...overrides.userRepo,
  } as any;
  const oidcGroupMappingRepo = {
    findByTenantId: jest.fn().mockResolvedValue([]),
    ...overrides.oidcGroupMappingRepo,
  } as any;
  const auditLogRepo = {
    createAuditLog: jest.fn(),
    ...overrides.auditLogRepo,
  } as any;
  const app = express();
  app.use(express.json());
  app.use(
    createOidcRouter({
      oidcAdapter,
      oidcProviderRepo,
      userRepo,
      oidcGroupMappingRepo,
      auditLogRepo,
      requireAdmin,
    }),
  );
  return { app, oidcAdapter, oidcProviderRepo, userRepo, oidcGroupMappingRepo, auditLogRepo };
}

describe('createOidcRouter authorize', () => {
  it('returns 400 when tenantId is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/auth/oidc/authorize');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no provider exists for the tenant', async () => {
    const { app, oidcProviderRepo } = makeApp();
    oidcProviderRepo.findByTenantId.mockResolvedValue(null);
    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=ghost');
    expect(res.status).toBe(404);
  });

  it('redirects to the IdP authorize URL on success', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.buildAuthorizeUrl.mockResolvedValue({ url: 'https://idp.example.com/authorize?x=1', state: 's1' });
    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=acme');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://idp.example.com/authorize?x=1');
  });

  it('forwards adapter failures to the error handler', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.buildAuthorizeUrl.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/auth/oidc/authorize?tenantId=acme');
    expect(res.status).toBe(500);
  });
});

describe('createOidcRouter admin providers', () => {
  it('rejects provider creation with missing required fields', async () => {
    const { app, oidcProviderRepo } = makeApp();
    const res = await request(app)
      .post('/api/auth/oidc/providers')
      .send({ tenantId: 'acme' });
    expect(res.status).toBe(400);
    expect(oidcProviderRepo.create).not.toHaveBeenCalled();
  });

  it('creates a provider without leaking the client secret', async () => {
    const { app, oidcProviderRepo } = makeApp();
    const res = await request(app)
      .post('/api/auth/oidc/providers')
      .send({
        tenantId: 'acme',
        name: 'Acme',
        issuerUrl: 'https://idp.example.com',
        clientId: 'client-123',
        redirectUris: 'https://app.example.com/callback',
      });
    expect(res.status).toBe(201);
    expect(res.body.client_secret).toBeUndefined();
    expect(oidcProviderRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'acme', name: 'Acme', issuerUrl: 'https://idp.example.com' }),
    );
  });

  it('forwards provider creation failures to the error handler', async () => {
    const { app, oidcProviderRepo } = makeApp();
    oidcProviderRepo.create.mockRejectedValue(new Error('db down'));
    const res = await request(app)
      .post('/api/auth/oidc/providers')
      .send({
        tenantId: 'acme',
        name: 'Acme',
        issuerUrl: 'https://idp.example.com',
        clientId: 'client-123',
        redirectUris: 'https://app.example.com/callback',
      });
    expect(res.status).toBe(500);
  });

  it('lists providers without leaking client secrets', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/auth/oidc/providers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].client_secret).toBeUndefined();
  });

  it('forwards provider listing failures to the error handler', async () => {
    const { app, oidcProviderRepo } = makeApp();
    oidcProviderRepo.findAll.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/api/auth/oidc/providers');
    expect(res.status).toBe(500);
  });
});

describe('createOidcRouter callback errors', () => {
  it('returns 400 when code or state is missing', async () => {
    const { app } = makeApp();
    const missingCode = await request(app).get('/api/auth/oidc/callback?state=abc');
    expect(missingCode.status).toBe(400);
    const missingState = await request(app).get('/api/auth/oidc/callback?code=abc');
    expect(missingState.status).toBe(400);
  });

  it('returns 404 when the flow tenant has no provider', async () => {
    const { app, oidcProviderRepo, oidcAdapter } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'ghost' });
    oidcProviderRepo.findByTenantId.mockResolvedValue(null);
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(404);
  });

  it('maps expired/invalid/mismatch failures to 401', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockRejectedValue(new Error('ID token nonce mismatch'));
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(401);
  });

  it('forwards unexpected callback failures to the error handler', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockRejectedValue(new Error('random failure'));
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(500);
  });

  it('maps claim groups to a role and updates the user when groups change', async () => {
    const { app, oidcAdapter, userRepo, oidcGroupMappingRepo, auditLogRepo } = makeApp({
      userRepo: {
        // No last_oidc_groups stored yet — exercises the `|| []` fallback.
        findByEmail: jest.fn().mockResolvedValue({ id: 'u1' }),
        updateUser: jest.fn().mockResolvedValue(undefined),
      },
      oidcGroupMappingRepo: {
        findByTenantId: jest.fn().mockResolvedValue([{ claim_group: 'startups', revora_role: 'startup' }]),
      },
    });
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockResolvedValue({
      sub: 'user-42',
      email: 'u@example.com',
      groups: ['startups'],
    });

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBe('startup');
    expect(res.body.tenantId).toBe('acme');
    expect(oidcGroupMappingRepo.findByTenantId).toHaveBeenCalledWith('acme');
    expect(auditLogRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'u1',
      action: 'oidc.claim.changed',
    }));
    expect(userRepo.updateUser).toHaveBeenCalledWith({
      id: 'u1',
      last_oidc_groups: ['startups'],
      role: 'startup',
    });
  });

  it('handles callback claims without groups gracefully', async () => {
    const { app, oidcAdapter, oidcGroupMappingRepo } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockResolvedValue({ sub: 'user-42', email: 'u@example.com' });

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBeUndefined();
    expect(oidcGroupMappingRepo.findByTenantId).not.toHaveBeenCalled();
  });

  it('skips user reconciliation when claims carry no email', async () => {
    const { app, oidcAdapter, userRepo } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockResolvedValue({ sub: 'user-42', groups: ['startups'] });

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');

    expect(res.status).toBe(200);
    expect(userRepo.findByEmail).not.toHaveBeenCalled();
  });

  it('leaves the user untouched when groups are unchanged and no role maps', async () => {
    const { app, oidcAdapter, userRepo, auditLogRepo } = makeApp({
      userRepo: {
        findByEmail: jest.fn().mockResolvedValue({ id: 'u1', last_oidc_groups: ['startups'] }),
        updateUser: jest.fn(),
      },
      oidcGroupMappingRepo: {
        findByTenantId: jest.fn().mockResolvedValue([]),
      },
    });
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockResolvedValue({
      sub: 'user-42',
      email: 'u@example.com',
      groups: ['startups'],
    });

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');

    expect(res.status).toBe(200);
    expect(res.body.mappedRole).toBeUndefined();
    expect(auditLogRepo.createAuditLog).not.toHaveBeenCalled();
    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('skips user updates when the email matches no user', async () => {
    const { app, oidcAdapter, userRepo, auditLogRepo } = makeApp({
      userRepo: {
        findByEmail: jest.fn().mockResolvedValue(null),
        updateUser: jest.fn(),
      },
      oidcGroupMappingRepo: {
        // Mapping exists but does not match the claim group — exercises the
        // predicate's no-match arm.
        findByTenantId: jest.fn().mockResolvedValue([{ claim_group: 'investors', revora_role: 'investor' }]),
      },
    });
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockResolvedValue({
      sub: 'user-42',
      email: 'ghost@example.com',
      groups: ['startups'],
    });

    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');

    expect(res.status).toBe(200);
    expect(userRepo.findByEmail).toHaveBeenCalledWith('ghost@example.com');
    expect(auditLogRepo.createAuditLog).not.toHaveBeenCalled();
    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('forwards non-Error callback failures to the error handler', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.consumeFlowState.mockReturnValue({ tenantId: 'acme' });
    oidcAdapter.validateIdToken.mockRejectedValue('boom');
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(500);
  });
});

describe('createOidcRouter logout route', () => {
  const validLogoutToken = (iss = 'https://idp.example.com') => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss })).toString('base64url');
    return `${h}.${p}.sig`;
  };

  it('returns 400 when logout_token is missing', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/auth/oidc/logout');
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed logout token', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: 'not-a-jwt' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the token has no issuer', async () => {
    const { app } = makeApp();
    const h = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({})).toString('base64url');
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: `${h}.${p}.sig` });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no provider matches the token issuer', async () => {
    const { app, oidcProviderRepo } = makeApp();
    oidcProviderRepo.findByIssuerUrl.mockResolvedValue(null);
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: validLogoutToken() });
    expect(res.status).toBe(400);
  });

  it('maps validation failures (expired/invalid/mismatch/replayed) to 400', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.validateLogoutToken.mockRejectedValue(new Error('Logout token replayed'));
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: validLogoutToken() });
    expect(res.status).toBe(400);
  });

  it('forwards non-Error logout failures to the error handler', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.validateLogoutToken.mockRejectedValue('boom');
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: validLogoutToken() });
    expect(res.status).toBe(500);
  });

  it('completes a valid logout and invalidates user sessions', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.validateLogoutToken.mockResolvedValue({ sub: 'user-42' });
    const { sessionStore } = await import('../../lib/sessionStore');
    const del = jest.spyOn(sessionStore, 'deleteAllForUser').mockResolvedValue(undefined);
    const { globalMetrics } = await import('../../lib/metrics');

    const res = await request(app).post('/auth/oidc/logout').send({ logout_token: validLogoutToken() });
    expect(res.status).toBe(200);
    expect(del).toHaveBeenCalledWith('user-42');
    expect(globalMetrics.getSnapshot()).toBeDefined();
    del.mockRestore();
  });

  it('forwards unexpected logout failures to the error handler', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.validateLogoutToken.mockRejectedValue(new Error('random failure'));
    const res = await request(app).post('/api/auth/oidc/logout').send({ logout_token: validLogoutToken() });
    expect(res.status).toBe(500);
  });
});
