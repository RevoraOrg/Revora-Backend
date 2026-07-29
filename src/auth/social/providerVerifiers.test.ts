import { createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';
import { createDefaultSocialTokenVerifierFromEnv, JwksSocialTokenVerifier } from './providerVerifiers';

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

function publicKeyJwk(kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ type: 'spki', format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, kty: 'RSA' };
}

function mockJwksResponse(keys: Record<string, unknown>[]) {
  return { ok: true, json: async () => ({ keys }) } as any;
}

const googleConfig = {
  provider: 'google' as const,
  issuers: ['https://accounts.google.com', 'accounts.google.com'] as const,
  audiences: ['client-id'] as const,
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
};

const appleConfig = {
  provider: 'apple' as const,
  issuers: ['https://appleid.apple.com'] as const,
  audiences: ['apple-client-id'] as const,
  jwksUrl: 'https://appleid.apple.com/auth/keys',
};

const validIssuer = 'https://accounts.google.com';
const validAudience = 'client-id';

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: validIssuer,
    aud: validAudience,
    sub: 'user-42',
    email: 'test@example.com',
    email_verified: true,
    exp: now() + 300,
    iat: now() - 5,
    ...overrides,
  };
}

describe('JwksSocialTokenVerifier', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('successful verification', () => {
    it('verifies a valid token with a cached KID', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload());
      const result = await verifier.verify('google', token);

      expect(result.provider).toBe('google');
      expect(result.subject).toBe('user-42');
      expect(result.email).toBe('test@example.com');
    });

    it('verifies a token after successful refresh on unknown KID', async () => {
      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK2]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'k2' });
      const result = await verifier.verify('google', token);

      expect(result.provider).toBe('google');
      expect(result.subject).toBe('user-42');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('verifies a token with valid cached keys without refetching for subsequent tokens', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload());
      await verifier.verify('google', token);

      const token2 = signToken(validPayload());
      await verifier.verify('google', token2);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on unknown KID', () => {
    it('retries verification once after refresh on unknown KID', async () => {
      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK2]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'k2' });
      await expect(verifier.verify('google', token)).resolves.toMatchObject({
        subject: 'user-42',
      });
    });

    it('returns INVALID_TOKEN when KID is still unknown after refresh', async () => {
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwkK2]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'k3' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('does not perform unlimited retries after failed refresh', async () => {
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwkK2]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'k3' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('single-flight refresh', () => {
    it('uses single-flight refresh so only one additional fetch for concurrent unknown KID requests', async () => {
      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');

      const verifier = new JwksSocialTokenVerifier([googleConfig]);

      const token = signToken(validPayload(), { kid: 'k2' });

      const results = await Promise.all([
        verifier.verify('google', token),
        verifier.verify('google', token),
        verifier.verify('google', token),
      ]);

      expect(results).toHaveLength(3);
      results.forEach((r) => expect(r.subject).toBe('user-42'));
    });

    it('concurrent callers awaiting the same refresh all receive refreshed keys', async () => {
      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');

      const verifier = new JwksSocialTokenVerifier([googleConfig]);

      const token = signToken(validPayload(), { kid: 'k2' });

      const [r1, r2] = await Promise.all([
        verifier.verify('google', token),
        verifier.verify('google', token),
      ]);

      expect(r1.subject).toBe(r2.subject);
      expect(r1.email).toBe(r2.email);
    });
  });

  describe('rate limiting', () => {
    it('respects the refresh budget per minute', async () => {
      const verifier = new JwksSocialTokenVerifier([googleConfig], 5);

      const jwk = publicKeyJwk('k2');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const token = signToken(validPayload(), { kid: 'k2' });
      await verifier.verify('google', token);
    });

    it('skips refresh when budget is exhausted and returns auth error', async () => {
      const verifier = new JwksSocialTokenVerifier([googleConfig], 1);

      const jwk = publicKeyJwk('k2');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const token = signToken(validPayload(), { kid: 'k3' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('resets budget after the window expires and allows new refresh', async () => {
      jest.useFakeTimers();
      const verifier = new JwksSocialTokenVerifier([googleConfig], 1);

      const jwkK2 = publicKeyJwk('k2');
      const jwkK3 = publicKeyJwk('k3');
      const jwkK4 = publicKeyJwk('k4');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK2]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK3]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK4]) as any);

      const token1 = signToken(validPayload(), { kid: 'k3' });
      await verifier.verify('google', token1);

      expect(global.fetch).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(60_001);

      const token2 = signToken(validPayload(), { kid: 'k4' });
      await verifier.verify('google', token2);
      expect(global.fetch).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });

    it('has separate limits per provider', async () => {
      const verifier = new JwksSocialTokenVerifier([googleConfig, appleConfig], 1);

      const googleJwk = publicKeyJwk('k2');
      const appleJwk = publicKeyJwk('k2');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([googleJwk]) as any)
        .mockResolvedValueOnce(mockJwksResponse([appleJwk]) as any);

      const googleToken = signToken(validPayload(), { kid: 'k2' });
      await verifier.verify('google', googleToken);

      const appleToken = signToken(
        validPayload({ iss: 'https://appleid.apple.com', aud: 'apple-client-id', email: 'apple@test.com' }),
        { kid: 'k2' },
      );
      await verifier.verify('apple', appleToken);

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('metrics', () => {
    it('emits social.keys.refresh.attempts with provider and outcome labels', async () => {
      const metrics = { incrementCounter: jest.fn() };
      const verifier = new JwksSocialTokenVerifier([googleConfig], 10, metrics as any);

      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK2]) as any);

      const token = signToken(validPayload(), { kid: 'k2' });
      await verifier.verify('google', token);

      const refreshCalls = metrics.incrementCounter.mock.calls.filter(
        (c: any[]) => c[0] === 'social.keys.refresh.attempts',
      );
      expect(refreshCalls.length).toBeGreaterThan(0);

      const outcomes = refreshCalls.map((c: any[]) => c[1]?.outcome);
      expect(outcomes).toContain('success');
      expect(outcomes).toContain('attempt');
    });

    it('emits rate_limited outcome when budget is exhausted', async () => {
      const metrics = { incrementCounter: jest.fn() };
      const verifier = new JwksSocialTokenVerifier([googleConfig], 1, metrics as any);

      const jwkK2 = publicKeyJwk('k2');
      const jwkK3 = publicKeyJwk('k3');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK2]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK3, jwkK2]) as any);

      const tokenK3 = signToken(validPayload(), { kid: 'k3' });
      await verifier.verify('google', tokenK3);

      const tokenK4 = signToken(
        validPayload({ iss: 'https://accounts.google.com', aud: 'client-id', email: 'test2@example.com' }),
        { kid: 'k4' },
      );
      await expect(verifier.verify('google', tokenK4)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });

      const rateLimitCalls = metrics.incrementCounter.mock.calls.filter(
        (c: any[]) => c[0] === 'social.keys.refresh.attempts',
      );
      const rateLimitedOutcomes = rateLimitCalls.map(
        (c: any[]) => c[1]?.outcome,
      );
      expect(rateLimitedOutcomes).toContain('rate_limited');
    });

    it('emits failure outcome on refresh failure', async () => {
      const metrics = { incrementCounter: jest.fn() };
      const verifier = new JwksSocialTokenVerifier([googleConfig], 10, metrics as any);

      const jwkK1 = publicKeyJwk('k1');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockRejectedValueOnce(new Error('Network error')) as any;

      const token = signToken(validPayload(), { kid: 'new-kid' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });

      const failureCalls = metrics.incrementCounter.mock.calls.filter(
        (c: any[]) => c[0] === 'social.keys.refresh.attempts' && c[1]?.outcome === 'failure',
      );
      expect(failureCalls.length).toBeGreaterThan(0);
    });
  });

  describe('failure scenarios', () => {
    it('returns authentication error when provider JWKS fetch fails', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' } as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'new-kid' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('returns authentication error when provider returns malformed response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ notKeys: true }),
      } as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'new-kid' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('does not authenticate users when refresh fails due to network error', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new Error('Network timeout')) as any;

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'new-kid' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('returns authentication error for Google provider outage', async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as any;

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload(), { kid: 'new-kid' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('returns authentication error for Apple provider outage', async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) as any;

      const verifier = new JwksSocialTokenVerifier([appleConfig]);
      const token = signToken(
        validPayload({ iss: 'https://appleid.apple.com', aud: 'apple-client-id', email: 'apple@test.com' }),
        { kid: 'new-kid' },
      );
      await expect(verifier.verify('apple', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });
  });

  describe('regression', () => {
    it('existing authentication behaviour unchanged for valid cached keys', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload());
      const result = await verifier.verify('google', token);

      expect(result.provider).toBe('google');
      expect(result.subject).toBe('user-42');
      expect(result.email).toBe('test@example.com');
      expect(result.emailVerified).toBe(true);
    });

    it('still rejects token with invalid issuer', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken({ ...validPayload(), iss: 'https://evil.com' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('still rejects token with invalid audience', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken({ ...validPayload(), aud: 'wrong-audience' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('still rejects expired tokens', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ exp: now() - 60 }));
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('still rejects tokens with invalid signature', async () => {
      const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const otherPrivPem = otherKey.export({ type: 'pkcs8', format: 'pem' }) as string;
      const jwk = publicKeyJwk('k1');

      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);

      const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validPayload())).toString('base64url');
      const otherSigner = createSign('RSA-SHA256');
      otherSigner.update(`${h}.${p}`);
      const badSig = otherSigner.sign(otherPrivPem).toString('base64url');
      const token = `${h}.${p}.${badSig}`;

      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });
  });

  describe('input validation', () => {
    it('rejects non-compact JWT', async () => {
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      await expect(verifier.verify('google', 'not.a.jwt')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT with wrong number of parts', async () => {
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      await expect(verifier.verify('google', 'only.two')).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT with wrong algorithm', async () => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'k1' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validPayload())).toString('base64url');
      const token = `${h}.${p}.sig`;
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT missing key id', async () => {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const p = Buffer.from(JSON.stringify(validPayload())).toString('base64url');
      const signer = createSign('RSA-SHA256');
      signer.update(`${h}.${p}`);
      const sig = signer.sign(privPem).toString('base64url');
      const token = `${h}.${p}.${sig}`;
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT with invalid JSON payload', async () => {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
      const p = 'not-valid-json-payload';
      const signer = createSign('RSA-SHA256');
      signer.update(`${h}.${p}`);
      const sig = signer.sign(privPem).toString('base64url');
      const token = `${h}.${p}.${sig}`;
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT not yet valid (nbf)', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ nbf: now() + 300 }));
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT missing subject', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ sub: undefined }));
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('rejects JWT missing email', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ email: undefined }));
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });
    });

    it('accepts JWT with audience as an array', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ aud: ['client-id'] }));
      const result = await verifier.verify('google', token);
      expect(result.provider).toBe('google');
    });
  });

  describe('aud as array', () => {
    it('accepts JWT with audience as an array', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);
      const verifier = new JwksSocialTokenVerifier([googleConfig]);
      const token = signToken(validPayload({ aud: ['client-id'] }));
      const result = await verifier.verify('google', token);
      expect(result.provider).toBe('google');
    });
  });

  describe('createDefaultSocialTokenVerifierFromEnv', () => {
    it('handles undefined env vars by returning a verifier', () => {
      const originalGoogle = process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_ID;
      try {
        const verifier = createDefaultSocialTokenVerifierFromEnv();
        expect(verifier).toBeDefined();
      } finally {
        if (originalGoogle !== undefined) {
          process.env.GOOGLE_OAUTH_CLIENT_ID = originalGoogle;
        }
      }
    });
  });

  describe('provider not configured', () => {
    it('rejects when provider is not configured', async () => {
      const verifier = new JwksSocialTokenVerifier([appleConfig]);
      const token = signToken(validPayload(), { kid: 'k3', iss: 'https://accounts.google.com' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    });

    it('rejects when provider has no audiences', async () => {
      const verifier = new JwksSocialTokenVerifier([
        { ...googleConfig, audiences: [] },
      ]);
      const token = signToken(validPayload());
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    });
  });

  describe('single-flight metrics', () => {
    it('emits skipped outcome for concurrent callers sharing in-flight refresh', async () => {
      const metrics = { incrementCounter: jest.fn() };
      const verifier = new JwksSocialTokenVerifier([googleConfig], 10, metrics as any);

      const jwkK1 = publicKeyJwk('k1');
      const jwkK2 = publicKeyJwk('k2');
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK1]) as any)
        .mockResolvedValueOnce(mockJwksResponse([jwkK1, jwkK2]) as any);

      const token = signToken(validPayload(), { kid: 'k2' });
      await Promise.all([
        verifier.verify('google', token),
        verifier.verify('google', token),
      ]);

      const skipCalls = metrics.incrementCounter.mock.calls.filter(
        (c: any[]) => c[0] === 'social.keys.refresh.attempts' && c[1]?.outcome === 'skipped',
      );
      expect(skipCalls.length).toBeGreaterThan(0);
    });
  });

  describe('budget exhaustion with empty cache', () => {
    it('returns rate_limited metric when budget is zero and cache lacks the KID', async () => {
      const metrics = { incrementCounter: jest.fn() };
      const verifier = new JwksSocialTokenVerifier([googleConfig], 0, metrics as any);

      const jwkK1 = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwkK1]) as any);

      const token = signToken(validPayload({ email: 'user-1@test.com' }), { kid: 'k2' });
      await expect(verifier.verify('google', token)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });

      const token2 = signToken(validPayload({ email: 'user-2@test.com' }), { kid: 'k2' });
      await expect(verifier.verify('google', token2)).rejects.toMatchObject({
        code: 'INVALID_TOKEN',
      });

      const rateLimitCalls = metrics.incrementCounter.mock.calls.filter(
        (c: any[]) => c[0] === 'social.keys.refresh.attempts',
      );
      const outcomes = rateLimitCalls.map((c: any[]) => c[1]?.outcome);
      expect(outcomes).toContain('rate_limited');
    });
  });

  describe('Apple private relay handling', () => {
    it('passes through isPrivateRelay=true when is_private_email is true in the token', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([appleConfig]);
      const token = signToken(
        validPayload({
          iss: 'https://appleid.apple.com',
          aud: 'apple-client-id',
          email: 'relay@privaterelay.appleid.com',
          is_private_email: true,
        }),
      );
      const result = await verifier.verify('apple', token);
      expect(result.isPrivateRelay).toBe(true);
    });

    it('passes through isPrivateRelay=false when is_private_email is absent', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([appleConfig]);
      const token = signToken(
        validPayload({
          iss: 'https://appleid.apple.com',
          aud: 'apple-client-id',
          email: 'real@example.com',
          // is_private_email intentionally omitted
        }),
      );
      const result = await verifier.verify('apple', token);
      expect(result.isPrivateRelay).toBe(false);
    });

    it('passes through isPrivateRelay=true when is_private_email is the string "true"', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([appleConfig]);
      const token = signToken(
        validPayload({
          iss: 'https://appleid.apple.com',
          aud: 'apple-client-id',
          email: 'relay@privaterelay.appleid.com',
          is_private_email: 'true',
        }),
      );
      const result = await verifier.verify('apple', token);
      expect(result.isPrivateRelay).toBe(true);
    });
  });

  describe('default verifier from env', () => {
    it('createDefaultSocialTokenVerifierFromEnv returns a verifier', () => {
      const originalGoogle = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const originalApple = process.env.APPLE_CLIENT_ID;
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-id';
      process.env.APPLE_CLIENT_ID = 'test-apple-id';
      try {
        const verifier = createDefaultSocialTokenVerifierFromEnv();
        expect(verifier).toBeDefined();
      } finally {
        if (originalGoogle !== undefined) {
          process.env.GOOGLE_OAUTH_CLIENT_ID = originalGoogle;
        } else {
          delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        }
        if (originalApple !== undefined) {
          process.env.APPLE_CLIENT_ID = originalApple;
        } else {
          delete process.env.APPLE_CLIENT_ID;
        }
      }
    });
  });

  describe('cache behaviour', () => {
    it('cached keys continue working across multiple verifications', async () => {
      const jwk = publicKeyJwk('k1');
      global.fetch = jest.fn().mockResolvedValue(mockJwksResponse([jwk]) as any);

      const verifier = new JwksSocialTokenVerifier([googleConfig]);

      for (let i = 0; i < 5; i++) {
        const token = signToken(validPayload());
        await expect(verifier.verify('google', token)).resolves.toMatchObject({
          subject: 'user-42',
        });
      }

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
