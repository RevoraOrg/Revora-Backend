/**
 * Comprehensive tests for the Mobile Companion API minimum-version enforcement
 * middleware (src/middleware/mobileMinVersion.ts).
 *
 * Covers:
 * - Semver parsing and comparison
 * - Policy signature verification (Ed25519)
 * - Signed policy loading (valid, invalid, expired, counter downgrade)
 * - Version gate evaluation (allow, reject, missing header, bad format)
 * - Express middleware integration (via supertest)
 * - Metrics emission
 * - Edge cases and security invariants
 */

import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import {
  parseSemver,
  compareSemver,
  verifyPolicySignature,
  stableStringify,
  loadSignedPolicy,
  evaluateVersionGate,
  createMobileMinVersionMiddleware,
  MobileVersionPolicy,
  SignedPolicyBundle,
} from './mobileMinVersion';
import { errorHandler } from './errorHandler';
import { AppError } from '../lib/errors';

// ── Test key pair (generated once, reused across all tests) ──────────────────

let keyPair: { publicKey: string; privateKey: string };

beforeAll(() => {
  const kp = crypto.generateKeyPairSync('ed25519');
  keyPair = {
    publicKey: kp.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sign a policy document and return a SignedPolicyBundle.
 * Uses crypto.sign() (not createSign) because Ed25519 keys require the
 * low-level sign() API with null algorithm.
 */
function signPolicy(
  policy: MobileVersionPolicy,
  privateKeyPem: string,
): SignedPolicyBundle {
  const canonicalJson = stableStringify(policy);
  const policyBase64 = Buffer.from(canonicalJson, 'utf-8').toString('base64');
  const keyObj = crypto.createPrivateKey(privateKeyPem);
  const sigBuffer = crypto.sign(null as any, Buffer.from(canonicalJson, 'utf-8'), keyObj as any);
  const signatureBase64url = sigBuffer.toString('base64url');
  return { policyBase64, signatureBase64url };
}

function makePolicy(overrides: Partial<MobileVersionPolicy> = {}): MobileVersionPolicy {
  return {
    version: '1.0.0',
    counter: 1,
    minClientVersion: '2.0.0',
    upgradeUrl: 'https://example.com/upgrade',
    ...overrides,
  };
}

function makeReq(
  headers: Record<string, string> = {},
): express.Request {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    path: '/mobile/ping',
    method: 'GET',
  } as unknown as express.Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    get headers() { return headers; },
  };
  return res;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. parseSemver
// ═════════════════════════════════════════════════════════════════════════════

describe('parseSemver', () => {
  it('parses a standard semver string', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
  });

  it('parses a two-part version', () => {
    expect(parseSemver('2.5')).toEqual([2, 5, 0]);
  });

  it('handles large numbers', () => {
    expect(parseSemver('100.200.300')).toEqual([100, 200, 300]);
  });

  it('handles zeros', () => {
    expect(parseSemver('0.0.0')).toEqual([0, 0, 0]);
  });

  it('throws on single-segment version', () => {
    expect(() => parseSemver('5')).toThrow('Invalid semver');
  });

  it('treats non-numeric segments as 0', () => {
    expect(parseSemver('1.2.beta')).toEqual([1, 2, 0]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. compareSemver
// ═════════════════════════════════════════════════════════════════════════════

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns -1 when a < b (major)', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a > b (major)', () => {
    expect(compareSemver('3.0.0', '2.0.0')).toBe(1);
  });

  it('returns -1 when a < b (minor)', () => {
    expect(compareSemver('1.2.0', '1.3.0')).toBe(-1);
  });

  it('returns 1 when a > b (minor)', () => {
    expect(compareSemver('1.5.0', '1.3.0')).toBe(1);
  });

  it('returns -1 when a < b (patch)', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
  });

  it('returns 1 when a > b (patch)', () => {
    expect(compareSemver('1.2.9', '1.2.3')).toBe(1);
  });

  it('compares two-part versions correctly', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1.2', '1.3.0')).toBe(-1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. stableStringify
// ═════════════════════════════════════════════════════════════════════════════

describe('stableStringify', () => {
  it('produces deterministic output regardless of key insertion order', () => {
    const a = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const b = { a: 2, m: { a: 4, b: 3 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('sorts nested arrays of objects', () => {
    const a = { items: [{ b: 2, a: 1 }] };
    const b = { items: [{ a: 1, b: 2 }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('handles primitive values', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(null)).toBe('null');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. verifyPolicySignature
// ═════════════════════════════════════════════════════════════════════════════

describe('verifyPolicySignature', () => {
  it('returns true for a valid signature', () => {
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    const keyObj = crypto.createPrivateKey(keyPair.privateKey);
    const sigBuffer = crypto.sign(null as any, Buffer.from(canonicalJson, 'utf-8'), keyObj as any);
    const sigB64url = sigBuffer.toString('base64url');

    expect(verifyPolicySignature(canonicalJson, sigB64url, keyPair.publicKey)).toBe(true);
  });

  it('returns false for a tampered payload', () => {
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    const keyObj = crypto.createPrivateKey(keyPair.privateKey);
    const sigBuffer = crypto.sign(null as any, Buffer.from(canonicalJson, 'utf-8'), keyObj as any);
    const sigB64url = sigBuffer.toString('base64url');

    const tampered = stableStringify({ ...policy, counter: 999 });
    expect(verifyPolicySignature(tampered, sigB64url, keyPair.publicKey)).toBe(false);
  });

  it('returns false for a signature from a different key', () => {
    const otherKeyPair = crypto.generateKeyPairSync('ed25519');
    const otherPrivPem = otherKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    const keyObj = crypto.createPrivateKey(otherPrivPem);
    const sigBuffer = crypto.sign(null as any, Buffer.from(canonicalJson, 'utf-8'), keyObj as any);
    const sigB64url = sigBuffer.toString('base64url');

    expect(verifyPolicySignature(canonicalJson, sigB64url, keyPair.publicKey)).toBe(false);
  });

  it('returns false for garbage signature', () => {
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    expect(verifyPolicySignature(canonicalJson, 'not-a-valid-sig', keyPair.publicKey)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. loadSignedPolicy
// ═════════════════════════════════════════════════════════════════════════════

describe('loadSignedPolicy', () => {
  it('loads a valid signed policy', () => {
    const policy = makePolicy();
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.version).toBe('1.0.0');
    expect(loaded.counter).toBe(1);
    expect(loaded.minClientVersion).toBe('2.0.0');
    expect(loaded.upgradeUrl).toBe('https://example.com/upgrade');
  });

  it('rejects policy with invalid base64', () => {
    // Use a valid base64 string that decodes to invalid JSON
    const bundle: SignedPolicyBundle = {
      policyBase64: Buffer.from('not valid json', 'utf-8').toString('base64'),
      signatureBase64url: 'abc',
    };
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'not valid JSON',
    );
  });

  it('rejects policy with invalid JSON', () => {
    const bundle: SignedPolicyBundle = {
      policyBase64: Buffer.from('not json', 'utf-8').toString('base64'),
      signatureBase64url: 'abc',
    };
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'Policy document is not valid JSON',
    );
  });

  it('rejects policy missing version field', () => {
    const policy = { counter: 1, minClientVersion: '1.0.0', upgradeUrl: 'http://x' };
    const bundle = signPolicy(policy as any, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'missing required field: version',
    );
  });

  it('rejects policy missing counter field', () => {
    const policy = { version: '1.0.0', minClientVersion: '1.0.0', upgradeUrl: 'http://x' };
    const bundle = signPolicy(policy as any, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'missing required field: counter',
    );
  });

  it('rejects policy missing minClientVersion field', () => {
    const policy = { version: '1.0.0', counter: 1, upgradeUrl: 'http://x' };
    const bundle = signPolicy(policy as any, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'missing required field: minClientVersion',
    );
  });

  it('rejects policy missing upgradeUrl field', () => {
    const policy = { version: '1.0.0', counter: 1, minClientVersion: '1.0.0' };
    const bundle = signPolicy(policy as any, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'missing required field: upgradeUrl',
    );
  });

  it('rejects counter downgrade', () => {
    const policy = makePolicy({ counter: 5 });
    const bundle = signPolicy(policy, keyPair.privateKey);
    // Current counter is 10 — loading counter=5 should fail
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, 10)).toThrow(
      'counter downgrade rejected',
    );
  });

  it('accepts same counter (idempotent reload)', () => {
    const policy = makePolicy({ counter: 5 });
    const bundle = signPolicy(policy, keyPair.privateKey);
    // Current counter is 5 — loading counter=5 should succeed (idempotent)
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, 5);
    expect(loaded.counter).toBe(5);
  });

  it('accepts higher counter', () => {
    const policy = makePolicy({ counter: 20 });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, 10);
    expect(loaded.counter).toBe(20);
  });

  it('rejects expired policy', () => {
    const policy = makePolicy({
      expiresAt: '2020-01-01T00:00:00.000Z',
    });
    const bundle = signPolicy(policy, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow('expired');
  });

  it('accepts policy with future expiry', () => {
    const policy = makePolicy({
      expiresAt: '2099-12-31T23:59:59.999Z',
    });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.expiresAt).toBe('2099-12-31T23:59:59.999Z');
  });

  it('rejects policy with invalid expiresAt format', () => {
    const policy = makePolicy({
      expiresAt: 'not-a-date',
    });
    const bundle = signPolicy(policy, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow('expired');
  });

  it('rejects policy with invalid signature', () => {
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    const policyBase64 = Buffer.from(canonicalJson, 'utf-8').toString('base64');
    const bundle: SignedPolicyBundle = {
      policyBase64,
      signatureBase64url: 'invalid-signature-value',
    };
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'signature verification failed',
    );
  });

  it('rejects policy with invalid minClientVersion semver', () => {
    const policy = makePolicy({ minClientVersion: 'not-a-version' });
    const bundle = signPolicy(policy, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'Invalid minClientVersion semver',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. evaluateVersionGate
// ═════════════════════════════════════════════════════════════════════════════

describe('evaluateVersionGate', () => {
  const policy = makePolicy({ minClientVersion: '2.0.0' });

  it('allows request when client version is above minimum', () => {
    const result = evaluateVersionGate('2.1.0', policy);
    expect(result.allowed).toBe(true);
    expect(result.clientVersion).toBe('2.1.0');
  });

  it('allows request when client version equals minimum', () => {
    const result = evaluateVersionGate('2.0.0', policy);
    expect(result.allowed).toBe(true);
  });

  it('rejects request when client version is below minimum', () => {
    const result = evaluateVersionGate('1.9.9', policy);
    expect(result.allowed).toBe(false);
    expect(result.clientVersion).toBe('1.9.9');
    expect(result.error).toBeDefined();
    expect(result.error!.statusCode).toBe(503);
    expect(result.error!.details).toMatchObject({
      code: 'CLIENT_VERSION_TOO_OLD',
      minRequiredVersion: '2.0.0',
      clientVersion: '1.9.9',
      upgradeUrl: 'https://example.com/upgrade',
    });
  });

  it('allows request when client version header is missing', () => {
    const result = evaluateVersionGate(undefined, policy);
    expect(result.allowed).toBe(true);
    expect(result.clientVersion).toBeUndefined();
  });

  it('allows request when client version header is empty string', () => {
    const result = evaluateVersionGate('', policy);
    expect(result.allowed).toBe(true);
  });

  it('allows request when client version header is whitespace only', () => {
    const result = evaluateVersionGate('   ', policy);
    expect(result.allowed).toBe(true);
  });

  it('rejects request with invalid semver format', () => {
    const result = evaluateVersionGate('abc', policy);
    expect(result.allowed).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.statusCode).toBe(400);
    expect(result.error!.message).toContain('Invalid client version format');
  });

  it('trims whitespace from client version', () => {
    const result = evaluateVersionGate('  2.0.0  ', policy);
    expect(result.allowed).toBe(true);
  });

  it('rejects version 1.0.0 against minimum 2.0.0', () => {
    const result = evaluateVersionGate('1.0.0', policy);
    expect(result.allowed).toBe(false);
  });

  it('allows major version above minimum', () => {
    const result = evaluateVersionGate('3.0.0', policy);
    expect(result.allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. createMobileMinVersionMiddleware — unit behavior
// ═════════════════════════════════════════════════════════════════════════════

describe('createMobileMinVersionMiddleware', () => {
  it('throws when no public key is provided', () => {
    expect(() => createMobileMinVersionMiddleware({})).toThrow(
      'at least one of trustedPublicKeyPem or trustedPublicKeyBase64 is required',
    );
  });

  it('allows requests when no policy is loaded', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/mobile/ping');
    expect(res.status).toBe(200);
  });

  it('allows requests when client version satisfies policy', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });

    const policy = makePolicy({ minClientVersion: '2.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app)
      .get('/mobile/ping')
      .set('X-Client-Min-Version', '2.0.0');
    expect(res.status).toBe(200);
  });

  it('rejects requests when client version is below minimum', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });

    const policy = makePolicy({ minClientVersion: '3.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app)
      .get('/mobile/ping')
      .set('X-Client-Min-Version', '1.0.0');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.details).toMatchObject({
      code: 'CLIENT_VERSION_TOO_OLD',
      minRequiredVersion: '3.0.0',
      clientVersion: '1.0.0',
      upgradeUrl: 'https://example.com/upgrade',
    });
  });

  it('allows requests when no version header is sent (fail-open)', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });

    const policy = makePolicy({ minClientVersion: '3.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/mobile/ping');
    expect(res.status).toBe(200);
  });

  it('rejects invalid semver format in client header', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });

    const policy = makePolicy({ minClientVersion: '2.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app)
      .get('/mobile/ping')
      .set('X-Client-Min-Version', 'not-a-version');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('getCurrentPolicy returns null before loading', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    expect(gate.getCurrentPolicy()).toBeNull();
  });

  it('getCurrentPolicy returns policy after loading', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const policy = makePolicy();
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));
    expect(gate.getCurrentPolicy()).toEqual(policy);
  });

  it('clearPolicy resets the policy', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const policy = makePolicy();
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));
    expect(gate.getCurrentPolicy()).not.toBeNull();
    gate.clearPolicy();
    expect(gate.getCurrentPolicy()).toBeNull();
  });

  it('getCounter returns -1 before loading', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    expect(gate.getCounter()).toBe(-1);
  });

  it('getCounter returns the loaded counter', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const policy = makePolicy({ counter: 42 });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));
    expect(gate.getCounter()).toBe(42);
  });

  it('rejects counter downgrade on loadPolicy', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const p1 = makePolicy({ counter: 10 });
    gate.loadPolicy(signPolicy(p1, keyPair.privateKey));

    const p2 = makePolicy({ counter: 5 });
    expect(() => gate.loadPolicy(signPolicy(p2, keyPair.privateKey))).toThrow(
      'counter downgrade rejected',
    );
  });

  it('accepts idempotent reload (same counter)', () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const p = makePolicy({ counter: 10 });
    gate.loadPolicy(signPolicy(p, keyPair.privateKey));
    // Same counter — should not throw
    expect(() => gate.loadPolicy(signPolicy(p, keyPair.privateKey))).not.toThrow();
  });

  it('uses custom clientVersionHeader when provided', async () => {
    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
      clientVersionHeader: 'x-app-version',
    });

    const policy = makePolicy({ minClientVersion: '2.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.get('/mobile/ping', gate.middleware, (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    // With custom header — allowed
    const res1 = await request(app)
      .get('/mobile/ping')
      .set('X-App-Version', '2.0.0');
    expect(res1.status).toBe(200);

    // Without custom header — still allowed (fail-open)
    const res2 = await request(app).get('/mobile/ping');
    expect(res2.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Mobile companion route integration
// ═════════════════════════════════════════════════════════════════════════════

describe('Mobile companion routes — version gate integration', () => {
  // This test verifies that the version gate middleware is properly wired
  // into the mobile companion router's protected routes.
  it('rejects outdated client on /mobile/ping before device auth runs', async () => {
    const { createMobileCompanionRouter } = require('../routes/mobileCompanion');
    const { generateEd25519Keypair, InMemoryDeviceKeyStore, InMemoryReplayCache } = require('./deviceSignature');

    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyPem: keyPair.publicKey,
    });
    const policy = makePolicy({ minClientVersion: '5.0.0' });
    gate.loadPolicy(signPolicy(policy, keyPair.privateKey));

    const app = express();
    app.use(express.json());
    app.use(
      '/mobile',
      createMobileCompanionRouter({
        versionGateMiddleware: gate.middleware,
      }),
    );
    app.use(errorHandler);

    // Request with old version — should be rejected by version gate
    const res = await request(app)
      .get('/mobile/ping')
      .set('X-Client-Min-Version', '1.0.0');

    expect(res.status).toBe(503);
    expect(res.body.details?.code).toBe('CLIENT_VERSION_TOO_OLD');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Edge cases
// ═════════════════════════════════════════════════════════════════════════════

describe('Edge cases', () => {
  it('handles policy without expiresAt (no expiry)', () => {
    const policy = makePolicy({ expiresAt: undefined });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.expiresAt).toBeUndefined();
  });

  it('handles very large counter values', () => {
    const policy = makePolicy({ counter: Number.MAX_SAFE_INTEGER });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, Number.MAX_SAFE_INTEGER - 1);
    expect(loaded.counter).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('handles policy with counter 0 as first load', () => {
    const policy = makePolicy({ counter: 0 });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.counter).toBe(0);
  });

  it('rejects counter 0 when current is 1', () => {
    const policy = makePolicy({ counter: 0 });
    const bundle = signPolicy(policy, keyPair.privateKey);
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, 1)).toThrow(
      'counter downgrade rejected',
    );
  });

  it('handles policy version with many segments', () => {
    const policy = makePolicy({ version: '1.2.3.4' });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.version).toBe('1.2.3.4');
  });

  it('handles minClientVersion with two segments', () => {
    const policy = makePolicy({ minClientVersion: '2.0' });
    const bundle = signPolicy(policy, keyPair.privateKey);
    const loaded = loadSignedPolicy(bundle, keyPair.publicKey, -1);
    expect(loaded.minClientVersion).toBe('2.0');
  });

  it('rejects request with version 0.0.0 against minimum 1.0.0', () => {
    const policy = makePolicy({ minClientVersion: '1.0.0' });
    const result = evaluateVersionGate('0.0.0', policy);
    expect(result.allowed).toBe(false);
  });

  it('allows request with version 999.999.999 against minimum 1.0.0', () => {
    const policy = makePolicy({ minClientVersion: '1.0.0' });
    const result = evaluateVersionGate('999.999.999', policy);
    expect(result.allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Coverage gap — base64 DER key path and catch block
// ═════════════════════════════════════════════════════════════════════════════

describe('Coverage — base64 DER key path and edge cases', () => {
  it('supports trustedPublicKeyBase64 option (base64-encoded SPKI DER)', () => {
    // Extract the raw SPKI DER bytes from the PEM key
    const pemLines = keyPair.publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s/g, '');
    const derBase64 = pemLines; // PEM body is already base64-encoded DER

    const gate = createMobileMinVersionMiddleware({
      trustedPublicKeyBase64: derBase64,
    });

    const policy = makePolicy();
    const bundle = signPolicy(policy, keyPair.privateKey);
    // Should not throw — the base64 DER is converted to PEM internally
    const loaded = gate.loadPolicy(bundle);
    expect(loaded.version).toBe('1.0.0');
  });

  it('verifyPolicySignature returns false when createPublicKey throws (invalid key)', () => {
    const policy = makePolicy();
    const canonicalJson = stableStringify(policy);
    // Use a garbage PEM string that will cause createPublicKey to throw
    const result = verifyPolicySignature(
      canonicalJson,
      'AAAA',
      '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
    );
    expect(result).toBe(false);
  });

  it('loadSignedPolicy rejects base64 that decodes to invalid content (not a base64 decode error, but still invalid)', () => {
    // A string that is valid base64 but decodes to bytes that are not valid JSON
    const invalidContent = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
    const bundle: SignedPolicyBundle = {
      policyBase64: invalidContent,
      signatureBase64url: 'abc',
    };
    // This should throw with 'not valid JSON' since the base64 decodes
    // to bytes that can't be parsed as JSON
    expect(() => loadSignedPolicy(bundle, keyPair.publicKey, -1)).toThrow(
      'not valid JSON',
    );
  });

  it('evaluateVersionGate handles version with only major (single segment)', () => {
    const policy = makePolicy({ minClientVersion: '1.0.0' });
    // '5' is a single segment — parseSemver should throw
    const result = evaluateVersionGate('5', policy);
    expect(result.allowed).toBe(false);
    expect(result.error!.statusCode).toBe(400);
  });

  it('stableStringify handles nested arrays correctly', () => {
    const a = { items: [{ c: 3, a: 1, b: 2 }, { z: 0 }] };
    const b = { items: [{ a: 1, b: 2, c: 3 }, { z: 0 }] };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});
