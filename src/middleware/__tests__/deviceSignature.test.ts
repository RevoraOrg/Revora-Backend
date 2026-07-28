import crypto from 'crypto';
import {
  buildSignaturePayload,
  hashBody,
  verifyEd25519,
  generateEd25519Keypair,
  InMemoryDeviceKeyStore,
  InMemoryReplayCache,
  createDeviceSignatureMiddleware,
  AuthenticatedDeviceRequest,
} from '../deviceSignature';
import { Request, Response, NextFunction } from 'express';
import { ErrorCode } from '../../lib/errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Record<string, string> = {}): Request {
  return {
    method: 'POST',
    path: '/api/v1/mobile/ping',
    body: { hello: 'world' },
    header: (name: string) => overrides[name.toLowerCase()] ?? undefined,
    headers: {},
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

function collectError(next: NextFunction): { code?: string; message?: string } | null {
  let captured: any = null;
  const mockNext = (err: any) => {
    captured = err;
  };
  return captured;
}

// ── Unit tests ───────────────────────────────────────────────────────────────

describe('deviceSignature', () => {
  let keypair: ReturnType<typeof generateEd25519Keypair>;

  beforeAll(() => {
    keypair = generateEd25519Keypair();
  });

  describe('buildSignaturePayload', () => {
    it('should produce deterministic payload from inputs', () => {
      const payload = buildSignaturePayload(
        'POST',
        '/api/v1/mobile/ping',
        'abc123hash',
        '2026-01-01T00:00:00.000Z',
        'nonce-1',
      );
      expect(payload).toBe(
        'POST\n/api/v1/mobile/ping\nabc123hash\n2026-01-01T00:00:00.000Z\nnonce-1',
      );
    });

    it('should uppercase the HTTP method', () => {
      const payload = buildSignaturePayload('get', '/path', '', 'ts', 'n');
      expect(payload).toMatch(/^GET\n/);
    });
  });

  describe('hashBody', () => {
    it('should return SHA-256 of empty string for undefined body', () => {
      const h = hashBody(undefined);
      const expected = crypto.createHash('sha256').update('').digest('hex');
      expect(h).toBe(expected);
    });

    it('should hash a string body directly', () => {
      const h = hashBody('raw');
      const expected = crypto.createHash('sha256').update('raw').digest('hex');
      expect(h).toBe(expected);
    });

    it('should JSON-serialize and hash an object body', () => {
      const obj = { a: 1, b: 'two' };
      const h = hashBody(obj);
      const expected = crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
      expect(h).toBe(expected);
    });

    it('should hash null body as empty string', () => {
      const h = hashBody(null);
      const expected = crypto.createHash('sha256').update('').digest('hex');
      expect(h).toBe(expected);
    });
  });

  describe('verifyEd25519', () => {
    it('should return true for a valid signature', () => {
      const payload = 'test-payload';
      const sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(keypair.privateKey));
      const sigB64 = sig.toString('base64url');
      expect(verifyEd25519(keypair.publicKey, payload, sigB64)).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      expect(verifyEd25519(keypair.publicKey, 'test', 'aaaa')).toBe(false);
    });

    it('should return false for a tampered payload', () => {
      const payload = 'original-payload';
      const sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(keypair.privateKey));
      const sigB64 = sig.toString('base64url');
      expect(verifyEd25519(keypair.publicKey, 'tampered-payload', sigB64)).toBe(false);
    });

    it('should return false for a wrong public key', () => {
      const otherKeypair = generateEd25519Keypair();
      const payload = 'test';
      const sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(keypair.privateKey));
      const sigB64 = sig.toString('base64url');
      expect(verifyEd25519(otherKeypair.publicKey, payload, sigB64)).toBe(false);
    });
  });

  describe('generateEd25519Keypair', () => {
    it('should produce a valid PEM keypair', () => {
      const kp = generateEd25519Keypair();
      expect(kp.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
      expect(kp.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
      expect(kp.publicKey).toContain('Ed25519');
    });
  });

  describe('InMemoryDeviceKeyStore', () => {
    it('should return null for unknown install ID', async () => {
      const store = new InMemoryDeviceKeyStore();
      expect(await store.getPublicKey('unknown')).toBeNull();
    });

    it('should store and retrieve a public key', async () => {
      const store = new InMemoryDeviceKeyStore();
      await store.setPublicKey('id1', 'key1');
      expect(await store.getPublicKey('id1')).toBe('key1');
    });

    it('should clear all keys', async () => {
      const store = new InMemoryDeviceKeyStore();
      await store.setPublicKey('id1', 'key1');
      store.clear();
      expect(await store.getPublicKey('id1')).toBeNull();
    });
  });

  describe('InMemoryReplayCache', () => {
    it('should return false for the first encounter', () => {
      const cache = new InMemoryReplayCache();
      expect(cache.seen('key1')).toBe(false);
    });

    it('should return true for the second encounter', () => {
      const cache = new InMemoryReplayCache();
      cache.seen('key1');
      expect(cache.seen('key1')).toBe(true);
    });

    it('should allow reuse after maxAgeMs expires', () => {
      jest.useFakeTimers();
      const cache = new InMemoryReplayCache();
      cache.seen('key1', 1000);
      jest.advanceTimersByTime(1001);
      expect(cache.seen('key1', 1000)).toBe(false);
      jest.useRealTimers();
    });
  });

  describe('createDeviceSignatureMiddleware', () => {
    let store: InMemoryDeviceKeyStore;
    let replayCache: InMemoryReplayCache;
    const installId = 'install_test_123';

    beforeEach(async () => {
      store = new InMemoryDeviceKeyStore();
      replayCache = new InMemoryReplayCache();
      await store.setPublicKey(installId, keypair.publicKey);
    });

    function signRequest(
      method: string,
      path: string,
      body: unknown,
      timestamp: string,
      nonce: string,
    ): string {
      const bodyHash = hashBody(body);
      const payload = buildSignaturePayload(method, path, bodyHash, timestamp, nonce);
      const sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(keypair.privateKey));
      return sig.toString('base64url');
    }

    it('should call next() with error when headers are missing', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const req = makeReq({});
      const errors: any[] = [];
      const next = (err: any) => errors.push(err);

      await mw(req, makeRes(), next);

      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe(ErrorCode.BAD_REQUEST);
    });

    it('should reject invalid timestamp', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const sig = signRequest('POST', '/api/v1/mobile/ping', { hello: 'world' }, 'not-a-date', 'nonce1');
      const req = makeReq({
        'x-device-install-id': installId,
        'x-device-timestamp': 'not-a-date',
        'x-device-nonce': 'nonce1',
        'x-device-signature': sig,
      });
      const errors: any[] = [];
      await mw(req, makeRes(), (err: any) => errors.push(err));

      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe(ErrorCode.BAD_REQUEST);
      expect(errors[0].message).toContain('timestamp');
    });

    it('should reject expired timestamp (outside clock skew)', async () => {
      const mw = createDeviceSignatureMiddleware({
        keyStore: store,
        replayCache,
        clockSkewMs: 5000,
      });
      const oldTime = new Date(Date.now() - 10_000).toISOString();
      const sig = signRequest('POST', '/api/v1/mobile/ping', { hello: 'world' }, oldTime, 'nonce2');
      const req = makeReq({
        'x-device-install-id': installId,
        'x-device-timestamp': oldTime,
        'x-device-nonce': 'nonce2',
        'x-device-signature': sig,
      });
      const errors: any[] = [];
      await mw(req, makeRes(), (err: any) => errors.push(err));

      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe(ErrorCode.BAD_REQUEST);
      expect(errors[0].message).toContain('clock-skew');
    });

    it('should reject unknown install ID', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const now = new Date().toISOString();
      const sig = signRequest('POST', '/api/v1/mobile/ping', { hello: 'world' }, now, 'nonce3');
      const req = makeReq({
        'x-device-install-id': 'unknown_install',
        'x-device-timestamp': now,
        'x-device-nonce': 'nonce3',
        'x-device-signature': sig,
      });
      const errors: any[] = [];
      await mw(req, makeRes(), (err: any) => errors.push(err));

      expect(errors.length).toBe(1);
      expect(errors[0].code).toBe(ErrorCode.UNAUTHORIZED);
      expect(errors[0].message).toContain('Unknown device');
    });

    it('should reject replayed nonce', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const now = new Date().toISOString();
      const sig = signRequest('POST', '/api/v1/mobile/ping', { hello: 'world' }, now, 'nonce-replay');

      const makeGoodReq = () =>
        makeReq({
          'x-device-install-id': installId,
          'x-device-timestamp': now,
          'x-device-nonce': 'nonce-replay',
          'x-device-signature': sig,
        });

      const errors1: any[] = [];
      await mw(makeGoodReq(), makeRes(), (err: any) => errors1.push(err));
      expect(errors1.length).toBe(0);

      const errors2: any[] = [];
      await mw(makeGoodReq(), makeRes(), (err: any) => errors2.push(err));
      expect(errors2.length).toBe(1);
      expect(errors2[0].message).toContain('Replay');
    });

    it('should accept a valid signature and attach deviceAuth', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const now = new Date().toISOString();
      const sig = signRequest('POST', '/api/v1/mobile/ping', { hello: 'world' }, now, 'valid-nonce-1');
      const req = makeReq({
        'x-device-install-id': installId,
        'x-device-timestamp': now,
        'x-device-nonce': 'valid-nonce-1',
        'x-device-signature': sig,
      });

      let nextCalled = false;
      await mw(req, makeRes(), () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect((req as AuthenticatedDeviceRequest).deviceAuth).toEqual({
        installId,
        publicKey: keypair.publicKey,
      });
    });
  });
});
