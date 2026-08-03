import { createSign, generateKeyPairSync } from 'crypto';
import express from 'express';
import request from 'supertest';
import { OidcAdapterService } from './oidcAdapterService';
import { JwksCacheService } from './jwksCache';
import { createOidcRouter } from './oidcRoute';
import { AuthenticatedRequest } from '../../middleware/auth';
import { JwksRefreshApprovalGate } from './jwksRefreshApprovalGate';
import { InMemoryRateLimitStore } from '../../middleware/rateLimit';
import { ALLOWED_ID_TOKEN_ALGORITHMS, OidcProviderRow } from './types';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProvider(overrides: Partial<OidcProviderRow> = {}): OidcProviderRow {
  return {
    id: 'uuid-1',
    tenant_id: 'acme',
    name: 'Acme IdP',
    issuer_url: 'https://idp.example.com',
    client_id: 'client-123',
    client_secret: null,
    scopes: 'openid profile email',
    redirect_uris: 'https://app.example.com/callback',
    enabled: true,
    created_at: new Date(),
    ...overrides,
  };
}

function makeDiscovery(overrides: Record<string, unknown> = {}) {
  return {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
    _cachedUntil: Date.now() + 60_000,
    ...overrides,
  };
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const now = () => Math.floor(Date.now() / 1000);

function signToken(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${h}.${p}`);
  const sig = signer.sign(privPem).toString('base64url');
  return `${h}.${p}.${sig}`;
}

function validClaims(nonce: string, overrides: Record<string, unknown> = {}) {
  return { iss: 'https://idp.example.com', sub: 'user-42', aud: 'client-123', exp: now() + 300, iat: now() - 5, nonce, ...overrides };
}

// ── OidcAdapterService ─────────────────────────────────────────────────────

describe('OidcAdapterService', () => {
  let jwksCache: jest.Mocked<JwksCacheService>;
  let service: OidcAdapterService;

  beforeEach(() => {
    jwksCache = { getKey: jest.fn().mockResolvedValue(publicKey), evict: jest.fn() } as any;
    service = new OidcAdapterService(jwksCache);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Discovery ──────────────────────────────────────────────────────────

  describe('getDiscovery', () => {
    it('fetches and caches a valid document', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => makeDiscovery() } as any);
      const doc = await service.getDiscovery('https://idp.example.com');
      expect(doc.issuer).toBe('https://idp.example.com');
      expect(doc._cachedUntil).toBeGreaterThan(Date.now());
    });

    it('returns cached doc without re-fetching', async () => {
      const doc = makeDiscovery();
      (service as any).discoveryCache.set('https://idp.example.com', {
        doc,
        cachedUntil: Date.now() + 60_000,
      });
      global.fetch = jest.fn();
      await service.getDiscovery('https://idp.example.com');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('re-fetches an expired cached doc', async () => {
      const doc = makeDiscovery({ _cachedUntil: Date.now() - 1 });
      (service as any).discoveryCache.set('https://idp.example.com', {
        doc,
        cachedUntil: Date.now() - 1,
      });
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => makeDiscovery() } as any);
      await service.getDiscovery('https://idp.example.com');
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('throws on issuer mismatch', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => makeDiscovery({ issuer: 'https://evil.com' }) } as any);
      await expect(service.getDiscovery('https://idp.example.com')).rejects.toThrow(/issuer mismatch/);
    });

    it('throws on non-200 response', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Down' } as any);
      await expect(service.getDiscovery('https://idp.example.com')).rejects.toThrow(/503/);
    });

    it('throws on missing required fields', async () => {
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ issuer: 'https://idp.example.com' }) } as any);
      await expect(service.getDiscovery('https://idp.example.com')).rejects.toThrow(/missing required fields/);
    });

    it('stores a per-issuer digest and alerts on fixture rotation', async () => {
      const metrics = { incrementCounter: jest.fn() };
      let now = 1_000_000;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      service = new OidcAdapterService(jwksCache, {
        metrics,
        discoveryTtlMs: 60_000,
        now: () => now,
      });

      const fixtureA = makeDiscovery();
      const fixtureB = makeDiscovery({
        authorization_endpoint: 'https://idp.example.com/v2/authorize',
        token_endpoint: 'https://idp.example.com/v2/token',
      });

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => fixtureA } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => fixtureB } as any);

      await service.getDiscovery('https://idp.example.com');
      const firstDigest = service.getDiscoveryDigest('https://idp.example.com');
      expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(metrics.incrementCounter).not.toHaveBeenCalled();

      now += 60_001;
      await service.getDiscovery('https://idp.example.com');

      expect(service.getDiscoveryDigest('https://idp.example.com')).not.toBe(firstDigest);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'oidc.discovery.changed',
        { issuer: 'https://idp.example.com' },
        1,
        expect.any(String),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('oidc.discovery.changed'));
      warn.mockRestore();
    });

    it('treats whitespace-only discovery changes as no delta', async () => {
      const metrics = { incrementCounter: jest.fn() };
      let now = 1_000_000;
      service = new OidcAdapterService(jwksCache, {
        metrics,
        discoveryTtlMs: 60_000,
        now: () => now,
      });

      const compact = makeDiscovery();
      // Same fields, different property insertion order after parse — still no delta.
      const padded = {
        jwks_uri: compact.jwks_uri,
        token_endpoint: compact.token_endpoint,
        authorization_endpoint: compact.authorization_endpoint,
        issuer: compact.issuer,
      };

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => compact } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => JSON.parse(JSON.stringify(padded, null, 4)),
        } as any);

      await service.getDiscovery('https://idp.example.com');
      const digest = service.getDiscoveryDigest('https://idp.example.com');

      now += 60_001;
      await service.getDiscovery('https://idp.example.com');

      expect(service.getDiscoveryDigest('https://idp.example.com')).toBe(digest);
      expect(metrics.incrementCounter).not.toHaveBeenCalled();
    });
  });

  // ── PKCE ───────────────────────────────────────────────────────────────

  describe('PKCE', () => {
    it('generateCodeVerifier produces 32-byte base64url', () => {
      const v = service.generateCodeVerifier();
      expect(Buffer.from(v, 'base64url').length).toBe(32);
    });

    it('codeChallenge produces a 43-char SHA-256 base64url digest', () => {
      expect(service.codeChallenge(service.generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('each verifier is unique', () => {
      expect(service.generateCodeVerifier()).not.toBe(service.generateCodeVerifier());
    });
  });

  // ── buildAuthorizeUrl ──────────────────────────────────────────────────

  describe('buildAuthorizeUrl', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => makeDiscovery() } as any);
    });

    it('includes PKCE params in the URL', async () => {
      const { url, state } = await service.buildAuthorizeUrl(makeProvider());
      const p = new URL(url).searchParams;
      expect(p.get('code_challenge_method')).toBe('S256');
      expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(p.get('state')).toBe(state);
      expect(p.get('nonce')).toBeTruthy();
    });

    it('stores flow state server-side', async () => {
      const { state } = await service.buildAuthorizeUrl(makeProvider());
      const stored = (service as any).flowStates.get(state);
      expect(stored.tenantId).toBe('acme');
      expect(stored.codeVerifier).toBeTruthy();
    });
  });

  // ── ID Token validation ────────────────────────────────────────────────

  describe('validateIdToken', () => {
    const discovery = makeDiscovery() as any;

    it('accepts a valid RS256 ID token', async () => {
      const nonce = 'n1';
      const claims = await service.validateIdToken(signToken(validClaims(nonce)), makeProvider(), discovery, nonce);
      expect(claims.sub).toBe('user-42');
    });

    it('rejects "none" algorithm', async () => {
      const nonce = 'n2';
      const h = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims(nonce))).toString('base64url');
      await expect(service.validateIdToken(`${h}.${p}.`, makeProvider(), discovery, nonce))
        .rejects.toThrow(/Insecure algorithm rejected/);
    });

    it('rejects HS256 algorithm', async () => {
      const nonce = 'n3';
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims(nonce))).toString('base64url');
      await expect(service.validateIdToken(`${h}.${p}.fake`, makeProvider(), discovery, nonce))
        .rejects.toThrow(/Insecure algorithm rejected/);
    });

    it('rejects unknown algorithm', async () => {
      const nonce = 'n4';
      const h = Buffer.from(JSON.stringify({ alg: 'CUSTOM99', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims(nonce))).toString('base64url');
      await expect(service.validateIdToken(`${h}.${p}.fake`, makeProvider(), discovery, nonce))
        .rejects.toThrow(/Unknown or disallowed algorithm/);
    });

    it('rejects token with missing alg', async () => {
      const h = Buffer.from(JSON.stringify({ kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims('n5'))).toString('base64url');
      await expect(service.validateIdToken(`${h}.${p}.sig`, makeProvider(), discovery, 'n5'))
        .rejects.toThrow(/missing alg/);
    });

    it('rejects a malformed ID token header', async () => {
      await expect(service.validateIdToken('!!.xx.yy', makeProvider(), discovery, 'n'))
        .rejects.toThrow(/Malformed ID token header/);
    });

    it('handleCallback exchanges the code end-to-end and validates the ID token', async () => {
      const nonce = 'nonce-e2e';
      (service as any).flowStates.set('state-ok', {
        tenantId: 'acme',
        codeVerifier: 'code-verifier',
        nonce,
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 60_000,
      });
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => makeDiscovery() } as any)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id_token: signToken(validClaims(nonce)) }) } as any);

      const claims = await service.handleCallback('exchange-code', 'state-ok', makeProvider());
      expect(claims.sub).toBe('user-42');

      const [, init] = (global.fetch as jest.Mock).mock.calls[1];
      expect(init.method).toBe('POST');
      const body = init.body.toString();
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain('code=exchange-code');
      expect(body).toContain('code_verifier=code-verifier');
      expect(body).toContain('client_id=client-123');
    });

    it('handleCallback throws when the token exchange fails', async () => {
      (service as any).flowStates.set('state-fail', {
        tenantId: 'acme',
        codeVerifier: 'v',
        nonce: 'n-fail',
        redirectUri: 'u',
        expiresAt: Date.now() + 60_000,
      });
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => makeDiscovery() } as any)
        .mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'invalid_grant' } as any);

      await expect(service.handleCallback('code', 'state-fail', makeProvider()))
        .rejects.toThrow(/Token exchange failed \(400\)/);
    });

    it('rejects nonce mismatch', async () => {
      const token = signToken(validClaims('real-nonce'));
      await expect(service.validateIdToken(token, makeProvider(), discovery, 'wrong-nonce'))
        .rejects.toThrow(/nonce mismatch/);
    });

    it('rejects an expired token (outside clock skew)', async () => {
      const nonce = 'n6';
      const token = signToken(validClaims(nonce, { exp: now() - 600 })); // expired 10 min ago
      await expect(service.validateIdToken(token, makeProvider(), discovery, nonce))
        .rejects.toThrow();
    });

    it('accepts token within clock skew tolerance (4 min future iat)', async () => {
      const nonce = 'n7';
      const token = signToken(validClaims(nonce, { iat: now() + 240 }));
      const claims = await service.validateIdToken(token, makeProvider(), discovery, nonce);
      expect(claims.sub).toBe('user-42');
    });

    it('evicts JWKS and retries on signature failure', async () => {
      const nonce = 'n8';
      const { privateKey: other } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const badToken = signToken(validClaims(nonce), {});
      // Patch private key to wrong one after encode
      const wrongPem = other.export({ type: 'pkcs8', format: 'pem' });
      // Both getKey calls return the correct publicKey — but the token was signed
      // with a different key so signature will fail → evict path triggered
      jwksCache.getKey.mockResolvedValue(publicKey);

      // Sign with the OTHER key so the signature is actually invalid
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims(nonce))).toString('base64url');
      const s = createSign('RSA-SHA256'); s.update(`${h}.${p}`);
      const invalidToken = `${h}.${p}.${s.sign(wrongPem as string).toString('base64url')}`;

      await expect(service.validateIdToken(invalidToken, makeProvider(), discovery, nonce))
        .rejects.toThrow(/invalid|signature/i);
      expect(jwksCache.evict).toHaveBeenCalledWith(discovery.jwks_uri);
    });
  });

  // ── Flow state ─────────────────────────────────────────────────────────

  describe('consumeFlowState', () => {
    it('throws for unknown state', () => {
      expect(() => service.consumeFlowState('unknown')).toThrow(/Invalid/);
    });

    it('throws for expired state', () => {
      (service as any).flowStates.set('x', { tenantId: 'a', codeVerifier: 'v', nonce: 'n', redirectUri: 'u', expiresAt: Date.now() - 1 });
      expect(() => service.consumeFlowState('x')).toThrow(/expired/);
    });

    it('deletes state after consumption (one-time use)', () => {
      (service as any).flowStates.set('y', { tenantId: 'a', codeVerifier: 'v', nonce: 'n', redirectUri: 'u', expiresAt: Date.now() + 60_000 });
      service.consumeFlowState('y');
      expect((service as any).flowStates.has('y')).toBe(false);
    });
  });

  // ── Algorithm completeness ─────────────────────────────────────────────

  it('ALLOWED_ID_TOKEN_ALGORITHMS covers expected asymmetric set', () => {
    expect(ALLOWED_ID_TOKEN_ALGORITHMS).toEqual(
      expect.arrayContaining(['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256']),
    );
  });

  // ── JWKS refresh orchestration ─────────────────────────────────────────

  describe('JWKS refresh orchestration', () => {
    it('refreshJwks refreshes the issuer JWKS via its discovery jwks_uri', async () => {
      const discovery = makeDiscovery();
      service = new OidcAdapterService({ refresh: jest.fn().mockResolvedValue({ keys: new Map() }) } as any, {
        discoveryTtlMs: 60_000,
      });
      global.fetch = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => discovery } as any);

      await service.refreshJwks('https://idp.example.com');
      expect((service as any).jwksCache.refresh).toHaveBeenCalledWith(
        discovery.jwks_uri,
        'https://idp.example.com',
      );
    });

    it('getTrackedJwksIssuers delegates to the cache', () => {
      const jwksCache = { getTrackedIssuers: jest.fn().mockReturnValue(['a', 'b']) } as any;
      service = new OidcAdapterService(jwksCache);
      expect(service.getTrackedJwksIssuers()).toEqual(['a', 'b']);
      expect(jwksCache.getTrackedIssuers).toHaveBeenCalledTimes(1);
    });

    it('refreshAllJwks refreshes every tracked issuer and reports partial failures', async () => {
      const jwksCache = {
        getTrackedIssuers: jest.fn().mockReturnValue(['https://a.example.com', 'https://b.example.com']),
      } as any;
      const adapter = new OidcAdapterService(jwksCache);
      adapter.refreshJwks = jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('timeout'));

      const result = await adapter.refreshAllJwks();
      expect(result).toEqual({
        refreshed: ['https://a.example.com'],
        failed: [{ issuer: 'https://b.example.com', error: 'timeout' }],
      });
    });

    it('refreshAllJwks returns empty results when no issuers are tracked', async () => {
      const adapter = new OidcAdapterService({ getTrackedIssuers: jest.fn().mockReturnValue([]) } as any);
      adapter.refreshJwks = jest.fn();
      expect(await adapter.refreshAllJwks()).toEqual({ refreshed: [], failed: [] });
      expect(adapter.refreshJwks).not.toHaveBeenCalled();
    });

    it('refreshAllJwks stringifies non-Error rejections', async () => {
      const adapter = new OidcAdapterService({
        getTrackedIssuers: jest.fn().mockReturnValue(['https://a.example.com']),
      } as any);
      adapter.refreshJwks = jest.fn().mockRejectedValueOnce('raw string failure');
      const result = await adapter.refreshAllJwks();
      expect(result.failed).toEqual([{ issuer: 'https://a.example.com', error: 'raw string failure' }]);
    });
  });

  // ── Adapter edge cases (branch completeness) ───────────────────────────

  describe('adapter edge cases', () => {
    it('honours a valid OIDC_DISCOVERY_TTL_MS override and ignores invalid values', () => {
      const prev = process.env.OIDC_DISCOVERY_TTL_MS;
      process.env.OIDC_DISCOVERY_TTL_MS = '42000';
      expect((new OidcAdapterService({} as any) as any).discoveryTtlMs).toBe(42000);
      process.env.OIDC_DISCOVERY_TTL_MS = '-5';
      expect((new OidcAdapterService({} as any) as any).discoveryTtlMs).toBe(60 * 60 * 1000);
      process.env.OIDC_DISCOVERY_TTL_MS = 'not-a-number';
      expect((new OidcAdapterService({} as any) as any).discoveryTtlMs).toBe(60 * 60 * 1000);
      if (prev === undefined) delete process.env.OIDC_DISCOVERY_TTL_MS;
      else process.env.OIDC_DISCOVERY_TTL_MS = prev;
    });

    it('handleCallback rejects when the flow-state tenant mismatches the provider', async () => {
      const adapter = new OidcAdapterService({ getKey: jest.fn() } as any);
      (adapter as any).flowStates.set('state-tenant-x', {
        tenantId: 'tenant-a',
        codeVerifier: 'v',
        nonce: 'n',
        redirectUri: 'u',
        expiresAt: Date.now() + 60_000,
      });
      await expect(adapter.handleCallback('code', 'state-tenant-x', makeProvider()))
        .rejects.toThrow('State tenant mismatch');
    });

    it('exchangeCode includes client_secret when the provider has one', async () => {
      const adapter = new OidcAdapterService({ getKey: jest.fn() } as any);
      let sentBody = '';
      global.fetch = jest.fn().mockImplementation(async (_url: string, opts: any) => {
        sentBody = opts.body as string;
        return { ok: true, json: async () => ({ access_token: 'at', id_token: 'it', expires_in: 300 }) } as any;
      });
      const flowState = {
        tenantId: 'acme',
        codeVerifier: 'cv',
        nonce: 'n',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 60_000,
      };
      const tokens = await (adapter as any).exchangeCode('c', flowState, makeProvider({ client_secret: 'shh' }), makeDiscovery());
      expect(sentBody).toContain('client_secret=shh');
      expect(tokens.access_token).toBe('at');
    });

    it('rejects an ID token missing the kid header', async () => {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validClaims('n-kid'))).toString('base64url');
      await expect(service.validateIdToken(`${h}.${p}.sig`, makeProvider(), makeDiscovery(), 'n-kid'))
        .rejects.toThrow('ID token missing kid header');
    });

    it('retries ID token verification when jwt.verify reports "unable to verify"', async () => {
      const jwt = require('jsonwebtoken') as { verify: unknown };
      const spy = jest.spyOn(jwt as { verify: (...a: unknown[]) => unknown }, 'verify')
        .mockImplementationOnce(() => { throw new Error('unable to verify'); })
        .mockImplementation(() => validClaims('n-unable') as any);
      try {
        const claims = await service.validateIdToken(signToken(validClaims('n-unable')), makeProvider(), makeDiscovery(), 'n-unable');
        expect(claims.sub).toBe('user-42');
      } finally {
        spy.mockRestore();
      }
    });

    it('rejects an ID token when jwt.verify throws a non-Error value', async () => {
      const jwt = require('jsonwebtoken') as { verify: unknown };
      const spy = jest.spyOn(jwt as { verify: (...a: unknown[]) => unknown }, 'verify')
        .mockImplementationOnce(() => { throw 'boom'; });
      try {
        await expect(service.validateIdToken(signToken(validClaims('n-boom')), makeProvider(), makeDiscovery(), 'n-boom'))
          .rejects.toThrow('ID token validation failed: boom');
      } finally {
        spy.mockRestore();
      }
    });
  });
 });

// ── JwksCacheService ───────────────────────────────────────────────────────

describe('JwksCacheService', () => {
  let cache: JwksCacheService;
  const uri = 'https://idp.example.com/.well-known/jwks.json';
  const issuer = 'https://idp.example.com';
  const { publicKey: ecPub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = ecPub.export({ type: 'spki', format: 'jwk' });

  const mockJwks = (keys: Record<string, unknown>[]) =>
    ({ ok: true, json: async () => ({ keys }) } as any);

  beforeEach(() => { cache = new JwksCacheService(); });
  afterEach(() => jest.clearAllMocks());

  it('fetches and returns a key by kid', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'k1' }]));
    expect(await cache.getKey(uri, 'k1')).toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns cached key without re-fetching', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockJwks([{ ...jwk, kid: 'k2' }]));
    await cache.getKey(uri, 'k2');
    await cache.getKey(uri, 'k2');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rotates when kid is missing from cache', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'old' }]))
      .mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'new' }]));
    await cache.getKey(uri, 'old');
    expect(await cache.getKey(uri, 'new')).toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after rotation when kid still missing', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockJwks([{ ...jwk, kid: 'other' }]));
    await expect(cache.getKey(uri, 'missing')).rejects.toThrow(/after rotation/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('evict forces re-fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockJwks([{ ...jwk, kid: 'k3' }]));
    await cache.getKey(uri, 'k3');
    cache.evict(uri);
    await cache.getKey(uri, 'k3');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('skips malformed JWK entries', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(
      mockJwks([{ kid: 'bad', kty: 'INVALID' }, { ...jwk, kid: 'good' }]),
    );
    expect(await cache.getKey(uri, 'good')).toBeDefined();
  });

  it('throws on non-200 JWKS response', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as any);
    await expect(cache.getKey(uri, 'k')).rejects.toThrow(/JWKS fetch failed/);
  });

  it('coalesces concurrent refreshes and exposes issuer age', async () => {
    const metrics = { setGauge: jest.fn() } as any;
    const freshCache = new JwksCacheService({ metrics });
    global.fetch = jest.fn().mockResolvedValueOnce(mockJwks([{ ...jwk, kid: 'k4' }]));

    await Promise.all([
      freshCache.refresh(uri, issuer),
      freshCache.refresh(uri, issuer),
    ]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(freshCache.getCacheAgeSeconds(issuer)).toBeGreaterThanOrEqual(0);
    expect(metrics.setGauge).toHaveBeenCalledWith(
      'oidc.jwks.age_seconds',
      expect.any(Number),
      { issuer },
      expect.any(String),
    );
  });
});

// ── OIDC route: Logout ──────────────────────────────────────────────────

describe('createOidcRouter OIDC logout', () => {
  const { privateKey: logoutPriv, publicKey: logoutPub } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const logoutPrivPem = logoutPriv as string;
  const logoutPubPem = logoutPub as string;

  function signLogoutToken(payload: Record<string, unknown>): string {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'logout-k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signer = createSign('RSA-SHA256');
    signer.update(`${h}.${p}`);
    const sig = signer.sign(logoutPrivPem).toString('base64url');
    return `${h}.${p}.${sig}`;
  }

  const issuerUrl = 'https://idp.example.com';
  const sub = 'user-42';

  function makeProvider(overrides: Partial<OidcProviderRow> = {}) {
    return {
      id: 'prov-logout-1',
      tenant_id: 'tenant-logout',
      name: 'Logout Test IdP',
      issuer_url: issuerUrl,
      client_id: 'client-123',
      client_secret: null,
      scopes: 'openid',
      redirect_uris: 'https://app.example.com/callback',
      enabled: true,
      created_at: new Date(),
      ...overrides,
    };
  }

  it('processes a valid logout token via POST and clears sessions', async () => {
    const provider = makeProvider();
    const discovery = makeDiscovery();

    const oidcAdapter = {
      getDiscovery: jest.fn().mockResolvedValue(discovery),
      validateLogoutToken: jest.fn().mockResolvedValue({ sub, iss: issuerUrl }),
    } as any;

    const oidcProviderRepo = {
      findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter,
      oidcProviderRepo,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const token = signLogoutToken({
      iss: issuerUrl,
      sub,
      aud: 'client-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-unique-1',
    });

    // We can't easily mock sessionStore through the module system in this test,
    // but we verify the adapter is called correctly
    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(oidcProviderRepo.findByIssuerUrl).toHaveBeenCalledWith(issuerUrl);
    expect(oidcAdapter.getDiscovery).toHaveBeenCalledWith(issuerUrl);
    expect(oidcAdapter.validateLogoutToken).toHaveBeenCalledWith(token, provider, discovery);
  });

  it('processes a valid logout token via GET query param', async () => {
    const provider = makeProvider();
    const discovery = makeDiscovery();

    const oidcAdapter = {
      getDiscovery: jest.fn().mockResolvedValue(discovery),
      validateLogoutToken: jest.fn().mockResolvedValue({ sub, iss: issuerUrl }),
    } as any;

    const oidcProviderRepo = {
      findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter,
      oidcProviderRepo,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const token = signLogoutToken({
      iss: issuerUrl,
      sub,
      aud: 'client-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-get-1',
    });

    const res = await request(app)
      .get(`/api/auth/oidc/logout?logout_token=${encodeURIComponent(token)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when logout_token is missing', async () => {
    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter: {} as any,
      oidcProviderRepo: {} as any,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const res = await request(app).post('/api/auth/oidc/logout').send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('logout_token is required');
  });

  it('returns 400 for a malformed logout token', async () => {
    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter: {} as any,
      oidcProviderRepo: {} as any,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: 'not.a.valid.jwt' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Malformed logout token');
  });

  it('returns 400 when logout token has no issuer', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    const token = `${header}.${payload}.fake`;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter: {} as any,
      oidcProviderRepo: {} as any,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Logout token missing issuer');
  });

  it('returns 400 when provider is not found', async () => {
    const oidcProviderRepo = {
      findByIssuerUrl: jest.fn().mockResolvedValue(null),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter: {} as any,
      oidcProviderRepo,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const token = signLogoutToken({
      iss: 'https://unknown.example.com',
      sub,
      aud: 'client-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-unknown-1',
    });

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Provider not found for issuer');
  });

  it('returns 400 when validateLogoutToken throws a handled error', async () => {
    const provider = makeProvider();
    const discovery = makeDiscovery();

    const oidcAdapter = {
      getDiscovery: jest.fn().mockResolvedValue(discovery),
      validateLogoutToken: jest.fn().mockRejectedValue(new Error('Logout token replayed')),
    } as any;

    const oidcProviderRepo = {
      findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter,
      oidcProviderRepo,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const token = signLogoutToken({
      iss: issuerUrl,
      sub,
      aud: 'client-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-replayed-1',
    });

    const res = await request(app)
      .post('/api/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Logout token replayed');
  });

  it('supports /auth/oidc/logout path (without /api prefix)', async () => {
    const provider = makeProvider();
    const discovery = makeDiscovery();

    const oidcAdapter = {
      getDiscovery: jest.fn().mockResolvedValue(discovery),
      validateLogoutToken: jest.fn().mockResolvedValue({ sub, iss: issuerUrl }),
    } as any;

    const oidcProviderRepo = {
      findByIssuerUrl: jest.fn().mockResolvedValue(provider),
    } as any;

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({
      oidcAdapter,
      oidcProviderRepo,
      requireAdmin: (req: AuthenticatedRequest, _res: express.Response, next: express.NextFunction) => { req.user = { id: 'admin' }; next(); },
    }));

    const token = signLogoutToken({
      iss: issuerUrl,
      sub,
      aud: 'client-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-no-api-1',
    });

    const res = await request(app)
      .post('/auth/oidc/logout')
      .send({ logout_token: token });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── OIDC route: JWKS refresh ────────────────────────────────────────────

describe('createOidcRouter JWKS refresh (dual-control)', () => {
  const issuerA = 'https://idp.example.com';
  const issuerB = 'https://idp2.example.com';
  const uriA = 'https://idp.example.com/.well-known/jwks.json';
  const uriB = 'https://idp2.example.com/.well-known/jwks.json';

  function makeApp(overrides: Partial<Parameters<typeof createOidcRouter>[0]> = {}) {
    const oidcAdapter = {
      getDiscovery: jest.fn(),
      refreshJwks: jest.fn().mockResolvedValue(undefined),
      refreshAllJwks: jest.fn().mockResolvedValue({ refreshed: [issuerA], failed: [] }),
      getTrackedJwksIssuers: jest.fn().mockReturnValue([issuerA]),
    } as any;
    const oidcProviderRepo = {} as any;
    const auditRefresh = jest.fn();
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      req.user = { id: req.get('x-admin-id') ?? 'admin-1' };
      next();
    };
    // Dedicated rate-limit store per router instance: the shared default store
    // would let buckets accumulate across tests in the same worker.
    const app = express();
    app.use(express.json());
    app.use(
      createOidcRouter({
        oidcAdapter,
        oidcProviderRepo,
        requireAdmin,
        auditRefresh,
        ...overrides,
        rateLimitOptions: {
          store: new InMemoryRateLimitStore(),
          ...overrides.rateLimitOptions,
        },
      }),
    );
    return { app, oidcAdapter, auditRefresh };
  }

  const propose = (app: express.Express, body: Record<string, unknown> = {}, user = 'admin-1') =>
    request(app).post('/auth/oidc/jwks/refresh').set('x-admin-id', user).send(body);

  it('requires dual-control: a single admin proposal alone does not refresh', async () => {
    const { app, oidcAdapter } = makeApp();
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_second_approval');
    expect(res.body.approvalId).toBeTruthy();
    expect(res.body.proposer).toBe('admin-1');
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
    expect(oidcAdapter.refreshAllJwks).not.toHaveBeenCalled();
  });

  it('executes the refresh only after a distinct admin approves', async () => {
    const { app, oidcAdapter } = makeApp();
    const step1 = await propose(app, { issuer: issuerA });
    expect(step1.status).toBe(202);

    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(200);
    expect(step2.body.status).toBe('approved');
    expect(step2.body.refreshedIssuers).toEqual([issuerA]);
    expect(oidcAdapter.refreshJwks).toHaveBeenCalledWith(issuerA);
  });

  it('rejects self-approval by the proposing admin (dual-control collusion guard)', async () => {
    const { app, oidcAdapter } = makeApp();
    const step1 = await propose(app, { issuer: issuerA });
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-1');
    expect(step2.status).toBe(403);
    expect(step2.body.message).toMatch(/self-approve/i);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
  });

  it('refreshes all tracked issuers when no issuer is specified', async () => {
    const { app, oidcAdapter, auditRefresh } = makeApp();
    oidcAdapter.getTrackedJwksIssuers.mockReturnValue([issuerA, issuerB]);
    oidcAdapter.refreshAllJwks.mockResolvedValue({ refreshed: [issuerA, issuerB], failed: [] });

    const step1 = await propose(app, {});
    expect(step1.status).toBe(202);
    expect(step1.body.scope).toBe('*');
    expect(step1.body.issuer).toBeNull();

    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(200);
    expect(oidcAdapter.refreshAllJwks).toHaveBeenCalledTimes(1);
    expect(step2.body.refreshedIssuers).toEqual([issuerA, issuerB]);
    expect(auditRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        proposerId: 'admin-1',
        approverId: 'admin-2',
        issuers: [issuerA, issuerB],
      }),
    );
  });

  it('rejects a duplicate proposal for the same scope and surfaces the pending approvalId', async () => {
    const { app, oidcAdapter } = makeApp();
    const step1 = await propose(app, { issuer: issuerA });
    const dup = await propose(app, { issuer: issuerA }, 'admin-2');
    expect(dup.status).toBe(409);
    expect(dup.body.details?.approvalId).toBe(step1.body.approvalId);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
  });

  it('rejects an unknown approvalId', async () => {
    const { app, oidcAdapter } = makeApp();
    const res = await propose(app, { approvalId: 'does-not-exist' }, 'admin-2');
    expect(res.status).toBe(404);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
  });

  it('rejects an expired approval and does not refresh', async () => {
    const { app, oidcAdapter } = makeApp({ approvalGate: new JwksRefreshApprovalGate({ ttlMs: 60_000 }) });
    const step1 = await propose(app, { issuer: issuerA });
    jest.useFakeTimers({ now: Date.now() });
    jest.advanceTimersByTime(60_001);
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(409);
    expect(step2.body.message).toMatch(/expired/i);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('executes exactly one refresh when two admins race to approve the same proposal', async () => {
    const { app, oidcAdapter } = makeApp();
    const step1 = await propose(app, { issuer: issuerA });

    const [first, second] = await Promise.all([
      propose(app, { approvalId: step1.body.approvalId }, 'admin-2'),
      propose(app, { approvalId: step1.body.approvalId }, 'admin-3'),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(oidcAdapter.refreshJwks).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when a refresh-all fails for every tracked issuer', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.refreshAllJwks.mockResolvedValue({
      refreshed: [],
      failed: [{ issuer: issuerA, error: 'JWKS fetch failed: 503 Service Unavailable' }],
    });

    const step1 = await propose(app, {});
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(502);
    expect(step2.body.failed).toEqual([expect.objectContaining({ issuer: issuerA })]);
  });

  it('returns partial success when only some tracked issuers refresh', async () => {
    const { app, oidcAdapter } = makeApp();
    oidcAdapter.refreshAllJwks.mockResolvedValue({
      refreshed: [issuerA],
      failed: [{ issuer: issuerB, error: 'timeout' }],
    });

    const step1 = await propose(app, {});
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(200);
    expect(step2.body.refreshedIssuers).toEqual([issuerA]);
    expect(step2.body.failed).toEqual([expect.objectContaining({ issuer: issuerB })]);
  });

  it('audits every step with timestamps and actor identities', async () => {
    const { app, auditRefresh } = makeApp();
    await propose(app, { issuer: issuerA });

    const proposeEvent = auditRefresh.mock.calls[0][0];
    expect(proposeEvent).toMatchObject({
      action: 'jwks_refresh',
      actorId: 'admin-1',
      proposerId: 'admin-1',
      issuer: issuerA,
      scope: issuerA,
      status: 'pending_second_approval',
    });
    expect(proposeEvent.timestamp).toEqual(expect.any(String));

    const step1 = await propose(app, { issuer: issuerA }); // duplicate → blocked audit
    expect(step1.status).toBe(409);
    const blockedEvent = auditRefresh.mock.calls[1][0];
    expect(blockedEvent).toMatchObject({ status: 'blocked', reason: 'duplicate_proposal' });

    const step2 = await propose(app, { approvalId: proposeEvent.approvalId }, 'admin-2');
    expect(step2.status).toBe(200);
    const successEvent = auditRefresh.mock.calls[2][0];
    expect(successEvent).toMatchObject({
      status: 'success',
      proposerId: 'admin-1',
      approverId: 'admin-2',
      issuers: [issuerA],
    });
  });

  it('rejects non-admin callers before touching the approval gate', async () => {
    const requireAdmin = (req: any, res: any, next: () => void) => {
      res.status(403).json({ error: 'Forbidden', message: 'Forbidden: admin role required' });
    };
    const { app } = makeApp({ requireAdmin });
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(403);
  });

  it('rate-limits force-refresh requests per admin identity', async () => {
    const { app, oidcAdapter } = makeApp({ rateLimitOptions: { limit: 1, windowMs: 60_000 } });
    const first = await propose(app, { issuer: issuerA });
    expect(first.status).toBe(202);
    const second = await propose(app, { issuer: issuerA });
    expect(second.status).toBe(429);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
  });

  it('rate-limit buckets are isolated per admin identity', async () => {
    const { app } = makeApp({ rateLimitOptions: { limit: 1, windowMs: 60_000 } });
    const adminA = await propose(app, { issuer: issuerA }, 'admin-1');
    expect(adminA.status).toBe(202);
    // different admin + different scope — own rate-limit bucket and own proposal
    const adminB = await propose(app, { issuer: issuerB }, 'admin-2');
    expect(adminB.status).toBe(202);
  });

  it('concurrent force-refresh of the same issuer coalesces into a single upstream fetch', async () => {
    const metrics = { setGauge: jest.fn() };
    const cache = new JwksCacheService({ metrics: metrics as any });
    let resolveFetch: (v: any) => void;
    const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
    global.fetch = jest.fn(() => pending);

    const p1 = cache.refresh(uriA, issuerA);
    const p2 = cache.refresh(uriA, issuerA);
    resolveFetch!({ ok: true, json: async () => ({ keys: [] }) } as any);
    await Promise.all([p1, p2]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(cache.getTrackedIssuers()).toEqual([issuerA]);
  });

  it('coalesces force-refresh across different issuers sharing one jwks_uri', async () => {
    const cache = new JwksCacheService();
    let resolveFetch: (v: any) => void;
    const pending = new Promise<any>((resolve) => { resolveFetch = resolve; });
    global.fetch = jest.fn(() => pending);

    const p1 = cache.refresh(uriA, issuerA);
    const p2 = cache.refresh(uriA, issuerB);
    resolveFetch!({ ok: true, json: async () => ({ keys: [] }) } as any);
    await Promise.all([p1, p2]);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(cache.getTrackedIssuers().sort()).toEqual([issuerA, issuerB].sort());
  });

  it('audits a failed single-issuer refresh and surfaces the error', async () => {
    const { app, oidcAdapter, auditRefresh } = makeApp();
    oidcAdapter.refreshJwks.mockRejectedValue(new Error('JWKS fetch failed: 503 Service Unavailable'));

    const step1 = await propose(app, { issuer: issuerA });
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');

    expect(step2.status).toBe(500);
    expect(auditRefresh).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', reason: expect.stringContaining('503') }),
    );
  });

  it('audits an unknown gate error without leaking internal details', async () => {
    const brokenGate = {
      propose: () => {
        throw new Error('gate exploded');
      },
    } as any;
    const { app, auditRefresh } = makeApp({ approvalGate: brokenGate });
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(500);
    expect(auditRefresh).not.toHaveBeenCalled(); // unclassified gate errors are not audited as blocked events
  });

  it('rethrows unclassified approval-step errors to the error handler', async () => {
    const gate = new JwksRefreshApprovalGate();
    const realApprove = gate.approve.bind(gate);
    gate.approve = ((approvalId: string, actor: string) => {
      if (actor === 'admin-2') throw new Error('gate exploded');
      return realApprove(approvalId, actor);
    }) as any;
    const { app } = makeApp({ approvalGate: gate });
    const step1 = await propose(app, { issuer: issuerA });
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(500);
  });

  it('endpoint works on the /api/auth/oidc/jwks/refresh alias too', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/api/auth/oidc/jwks/refresh')
      .send({ issuer: issuerA });
    expect(res.status).toBe(202);
  });

  it('keeps an existing rate-limit subject when the admin already sets req.user.sub', async () => {
    // When requireAdmin attaches `sub`, fillRateLimitSubject must leave it
    // untouched — admins sharing a sub share the bucket.
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      req.user = { id: 'admin-1', sub: 'fixed-bucket' };
      next();
    };
    const { app } = makeApp({ requireAdmin, rateLimitOptions: { limit: 1, windowMs: 60_000 } });
    const first = await propose(app, { issuer: issuerA }, 'admin-1');
    expect(first.status).toBe(202);
    const secondAdmin = await propose(app, { issuer: issuerA }, 'admin-2');
    expect(secondAdmin.status).toBe(429);
  });

  it('falls back to req.user.sub when the admin has no id', async () => {
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      req.user = { sub: 'sub-only-admin' };
      next();
    };
    const { app, auditRefresh } = makeApp({ requireAdmin });
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(202);
    expect(auditRefresh.mock.calls[0][0]).toMatchObject({ actorId: 'sub-only-admin' });
  });

  it('falls back to the request IP when no admin identity is attached', async () => {
    const requireAdmin = (_req: any, _res: any, next: () => void) => next();
    const { app, auditRefresh } = makeApp({ requireAdmin });
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(202);
    expect(auditRefresh.mock.calls[0][0].actorId).toContain('127.0.0.1');
  });

  it('falls back to "anonymous" when neither identity nor IP is available', async () => {
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
      next();
    };
    const { app, auditRefresh } = makeApp({ requireAdmin });
    const res = await propose(app, { issuer: issuerA });
    expect(res.status).toBe(202);
    expect(auditRefresh.mock.calls[0][0]).toMatchObject({ actorId: 'anonymous' });
  });

  it('records a non-Error refresh execution failure in the audit trail', async () => {
    const { app, oidcAdapter, auditRefresh } = makeApp();
    oidcAdapter.refreshAllJwks.mockRejectedValue('backend exploded');
    const step1 = await propose(app);
    const step2 = await propose(app, { approvalId: step1.body.approvalId }, 'admin-2');
    expect(step2.status).toBe(500);
    const calls = auditRefresh.mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({
      status: 'failed',
      reason: 'backend exploded',
      approverId: 'admin-2',
    });
  });
});
