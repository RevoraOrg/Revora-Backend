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
});
