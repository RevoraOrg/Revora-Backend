import { createSign, generateKeyPairSync } from 'crypto';
import express from 'express';
import request from 'supertest';
import { OidcAdapterService } from './oidcAdapterService';
import { JwksCacheService } from './jwksCache';
import { createOidcRouter } from './oidcRoute';
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

// ── OIDC route ───────────────────────────────────────────────────────────

describe('createOidcRouter JWKS refresh', () => {
  it('requires admin dual confirmation before refreshing JWKS', async () => {
    const oidcAdapter = {
      getDiscovery: jest.fn(),
      refreshJwks: jest.fn().mockResolvedValue(undefined),
    } as any;
    const oidcProviderRepo = {} as any;
    const auditRefresh = jest.fn();
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      req.user = { id: 'admin-1' };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({ oidcAdapter, oidcProviderRepo, requireAdmin, auditRefresh }));

    const missingConfirmation = await request(app)
      .post('/api/auth/oidc/jwks/refresh')
      .set('x-revora-oidc-jwks-confirmation', 'true')
      .send({ confirmation: false, issuerUrl: 'https://idp.example.com' });

    expect(missingConfirmation.status).toBe(400);
    expect(oidcAdapter.refreshJwks).not.toHaveBeenCalled();
    expect(auditRefresh).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked' }));
  });

  it('rate-limits repeated refresh attempts for the same actor', async () => {
    const oidcAdapter = {
      getDiscovery: jest.fn(),
      refreshJwks: jest.fn().mockResolvedValue(undefined),
    } as any;
    const oidcProviderRepo = {} as any;
    const auditRefresh = jest.fn();
    const requireAdmin = (req: any, _res: any, next: () => void) => {
      req.user = { id: 'admin-2' };
      next();
    };

    const app = express();
    app.use(express.json());
    app.use(createOidcRouter({ oidcAdapter, oidcProviderRepo, requireAdmin, auditRefresh }));

    const first = await request(app)
      .post('/api/auth/oidc/jwks/refresh')
      .set('x-revora-oidc-jwks-confirmation', 'true')
      .send({ confirmation: true, issuerUrl: 'https://idp.example.com' });

    const second = await request(app)
      .post('/api/auth/oidc/jwks/refresh')
      .set('x-revora-oidc-jwks-confirmation', 'true')
      .send({ confirmation: true, issuerUrl: 'https://idp.example.com' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(oidcAdapter.refreshJwks).toHaveBeenCalledTimes(1);
  });
});
