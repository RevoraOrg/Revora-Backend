import { OidcAdapterService } from './oidcAdapterService';
import { JwksCacheService } from './jwksCache';
import { OidcProviderRow, OidcDiscoveryDocument } from './types';
import jwt from 'jsonwebtoken';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';

describe('OidcAdapterService - Logout Token Validation', () => {
  let adapter: OidcAdapterService;
  let jwksCache: jest.Mocked<JwksCacheService>;
  let provider: OidcProviderRow;
  let discovery: OidcDiscoveryDocument;
  let privateKey: string;
  let publicKey: string;

  beforeEach(() => {
    jwksCache = {
      getKey: jest.fn(),
      evict: jest.fn(),
      refresh: jest.fn(),
    } as unknown as jest.Mocked<JwksCacheService>;

    adapter = new OidcAdapterService(jwksCache);

    provider = {
      id: 'prov-1',
      tenant_id: 'tenant-1',
      name: 'Test Provider',
      issuer_url: 'https://issuer.example.com',
      client_id: 'client-1',
      client_secret: null,
      scopes: 'openid',
      redirect_uris: 'https://app.example.com/callback',
      enabled: true,
      created_at: new Date(),
    };

    discovery = {
      issuer: 'https://issuer.example.com',
      authorization_endpoint: 'https://issuer.example.com/auth',
      token_endpoint: 'https://issuer.example.com/token',
      jwks_uri: 'https://issuer.example.com/jwks',
    };

    const { privateKey: pk, publicKey: pub } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    privateKey = pk;
    publicKey = pub;

    jwksCache.getKey.mockResolvedValue(publicKey as any);
  });

  const signToken = (payload: any, options: jwt.SignOptions = {}) => {
    return jwt.sign(payload, privateKey, {
      algorithm: 'RS256',
      keyid: 'key-1',
      issuer: provider.issuer_url,
      audience: provider.client_id,
      ...options,
    });
  };

  it('validates a correct logout token', async () => {
    const token = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-1',
    });

    const claims = await adapter.validateLogoutToken(token, provider, discovery);
    expect(claims.sub).toBe('user-1');
    expect(claims.jti).toBe('jti-1');
  });

  it('rejects a token without the correct event', async () => {
    const token = signToken({
      sub: 'user-1',
      events: { 'some-other-event': {} },
    });

    await expect(adapter.validateLogoutToken(token, provider, discovery))
      .rejects.toThrow('Logout token missing backchannel-logout event');
  });

  it('rejects a token with a nonce', async () => {
    const token = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      nonce: 'invalid-nonce',
    });

    await expect(adapter.validateLogoutToken(token, provider, discovery))
      .rejects.toThrow('Logout token must not contain a nonce');
  });

  it('rejects a replayed token', async () => {
    const token = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-2',
    });

    await adapter.validateLogoutToken(token, provider, discovery);

    await expect(adapter.validateLogoutToken(token, provider, discovery))
      .rejects.toThrow('Logout token replayed');
  });

  it('rejects an invalid signature', async () => {
    const otherKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    
    const token = jwt.sign({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    }, otherKey.privateKey, {
      algorithm: 'RS256',
      keyid: 'key-1',
      issuer: provider.issuer_url,
      audience: provider.client_id,
    });

    await expect(adapter.validateLogoutToken(token, provider, discovery))
      .rejects.toThrow('Logout token signature invalid after JWKS rotation');
  });

  it('rejects a malformed logout token header', async () => {
    await expect(adapter.validateLogoutToken('!!.xx.yy', provider, discovery))
      .rejects.toThrow('Malformed logout token header');
  });

  it('rejects an insecure (none) logout token algorithm', async () => {
    const h = Buffer.from(JSON.stringify({ alg: 'none', kid: 'key-1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })).toString('base64url');
    await expect(adapter.validateLogoutToken(`${h}.${p}.`, provider, discovery))
      .rejects.toThrow('Insecure algorithm rejected');
  });

  it('rejects an unknown logout token algorithm', async () => {
    const h = Buffer.from(JSON.stringify({ alg: 'CUSTOM99', kid: 'key-1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ sub: 'user-1', events: { 'http://schemas.openid.net/event/backchannel-logout': {} } })).toString('base64url');
    await expect(adapter.validateLogoutToken(`${h}.${p}.sig`, provider, discovery))
      .rejects.toThrow('Unknown or disallowed algorithm');
  });

  it('rejects a logout token with a non-signature validation failure', async () => {
    const token = jwt.sign({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      exp: Math.floor(Date.now() / 1000) - 600, // beyond the 300s clock-skew window
    }, privateKey, {
      algorithm: 'RS256',
      keyid: 'key-1',
      issuer: provider.issuer_url,
      audience: provider.client_id,
    });
    await expect(adapter.validateLogoutToken(token, provider, discovery))
      .rejects.toThrow(/Logout token validation failed/);
  });

  it('lazily cleans up consumed jtis whose exp has passed', async () => {
    // Seed a stale entry, then validate a fresh token — the lazy cleanup must
    // drop the expired entry while keeping the freshly consumed one.
    (adapter as any).consumedJtis.set('seeded-stale', (Math.floor(Date.now() / 1000) - 3600) * 1000);

    const fresh = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-fresh',
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    await adapter.validateLogoutToken(fresh, provider, discovery);

    expect((adapter as any).consumedJtis.has('seeded-stale')).toBe(false);
    expect((adapter as any).consumedJtis.has('jti-fresh')).toBe(true);
  });

  it('does not retain a consumed jti whose exp has already passed', async () => {
    const stale = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
      jti: 'jti-stale',
      exp: Math.floor(Date.now() / 1000) - 60, // within clock skew, so it verifies
    });
    await adapter.validateLogoutToken(stale, provider, discovery);
    // set() then lazy-cleanup in the same call removes the self-expired entry
    expect((adapter as any).consumedJtis.has('jti-stale')).toBe(false);
  });

  it('rejects a logout token missing the alg header', async () => {
    const h = Buffer.from(JSON.stringify({ kid: 'key-1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })).toString('base64url');
    await expect(adapter.validateLogoutToken(`${h}.${p}.sig`, provider, discovery))
      .rejects.toThrow('Logout token missing alg header');
  });

  it('rejects a logout token missing the kid header', async () => {
    const h = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    })).toString('base64url');
    await expect(adapter.validateLogoutToken(`${h}.${p}.sig`, provider, discovery))
      .rejects.toThrow('Logout token missing kid header');
  });

  it('retries logout token verification when jwt.verify reports "unable to verify"', async () => {
    const originalVerify = jwt.verify.bind(jwt);
    const spy = jest.spyOn(jwt, 'verify')
      .mockImplementationOnce(() => { throw new Error('unable to verify'); })
      .mockImplementation((...args: Parameters<typeof jwt.verify>) => originalVerify(...args));
    try {
      const token = signToken({
        sub: 'user-1',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        jti: 'jti-retry-1',
      });
      const claims = await adapter.validateLogoutToken(token, provider, discovery);
      expect(claims.sub).toBe('user-1');
      expect(jwksCache.evict).toHaveBeenCalledWith(discovery.jwks_uri);
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts a logout token without a jti', async () => {
    const token = signToken({
      sub: 'user-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    const claims = await adapter.validateLogoutToken(token, provider, discovery);
    expect(claims.sub).toBe('user-1');
  });

  it('rejects a logout token when jwt.verify throws a non-Error value', async () => {
    const spy = jest.spyOn(jwt, 'verify')
      .mockImplementationOnce(() => { throw 'boom'; });
    try {
      const token = signToken({
        sub: 'user-1',
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        jti: 'jti-boom',
      });
      await expect(adapter.validateLogoutToken(token, provider, discovery))
        .rejects.toThrow('Logout token validation failed: boom');
    } finally {
      spy.mockRestore();
    }
  });
});
