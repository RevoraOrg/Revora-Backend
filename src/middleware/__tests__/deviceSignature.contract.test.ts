import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import {
  AuthenticatedDeviceRequest,
  DeviceKeyStore,
  InMemoryDeviceKeyStore,
  InMemoryReplayCache,
  buildSignaturePayload,
  createDeviceSignatureMiddleware,
  generateEd25519Keypair,
  hashBody,
} from '../deviceSignature';
import { ErrorCode } from '../../lib/errors';
import { globalMetrics } from '../../lib/metrics';

/**
 * Contract + failure-path suite for `src/middleware/deviceSignature.ts`.
 *
 * Complements `__tests__/deviceSignature.test.ts` (which covers the happy path
 * and the main rejections) by exercising the exported surface named in the
 * issue — `DeviceAuthContext`, `AuthenticatedDeviceRequest` and
 * `DeviceKeyStore` — together with the branches the existing suite does not
 * reach:
 *   - a key store that itself fails (must surface as a 500, never as a pass);
 *   - a key store holding an unusable PEM;
 *   - symmetric clock-skew (future timestamp), body and method tampering;
 *   - each required header missing individually;
 *   - the replay key composition (`install:timestamp:nonce`);
 *   - the `mobile.sig.verified` metric only incrementing on success.
 */

const REQUIRED_HEADERS = [
  'X-Device-Install-Id',
  'X-Device-Timestamp',
  'X-Device-Nonce',
  'X-Device-Signature',
] as const;

type RequiredHeader = (typeof REQUIRED_HEADERS)[number];

interface SignedRequestOptions {
  installId: string;
  privateKey: string;
  /** Method actually sent on the request. */
  method?: string;
  /** Method that was signed (defaults to `method`) — differs only in tamper tests. */
  signedMethod?: string;
  path?: string;
  body?: unknown;
  /** Body that was signed (defaults to `body`) — differs only in tamper tests. */
  signedBody?: unknown;
  timestamp?: string;
  nonce?: string;
  omitHeader?: RequiredHeader;
}

function headerKey(header: RequiredHeader): string {
  return `x-device-${header.replace(/^X-Device-/, '').toLowerCase()}`;
}

function makeRequest(opts: SignedRequestOptions): Request {
  const method = opts.method ?? 'POST';
  const path = opts.path ?? '/api/v1/mobile/ping';
  const body = opts.body ?? { hello: 'world' };
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const nonce = opts.nonce ?? 'nonce-1';

  const payload = buildSignaturePayload(
    opts.signedMethod ?? method,
    path,
    hashBody(opts.signedBody ?? body),
    timestamp,
    nonce,
  );
  const signature = crypto
    .sign(null, Buffer.from(payload), crypto.createPrivateKey(opts.privateKey))
    .toString('base64url');

  const headers: Record<string, string> = {
    'x-device-install-id': opts.installId,
    'x-device-timestamp': timestamp,
    'x-device-nonce': nonce,
    'x-device-signature': signature,
  };

  if (opts.omitHeader) delete headers[headerKey(opts.omitHeader)];

  return {
    method,
    path,
    body,
    header: (name: string) => headers[name.toLowerCase()],
    headers: {},
  } as unknown as Request;
}

interface Recorder {
  next: NextFunction;
  errors: any[];
}

function makeRecorder(): Recorder {
  const errors: any[] = [];
  const next = ((err?: unknown) => {
    if (err !== undefined) errors.push(err);
  }) as unknown as NextFunction;
  return { next, errors };
}

const noopResponse = {} as Response;

describe('deviceSignature contract & failure paths', () => {
  const keypair = generateEd25519Keypair();
  const otherKeypair = generateEd25519Keypair();
  const installId = 'install_contract_1';

  let store: InMemoryDeviceKeyStore;
  let replayCache: InMemoryReplayCache;

  beforeEach(async () => {
    store = new InMemoryDeviceKeyStore();
    replayCache = new InMemoryReplayCache();
    await store.setPublicKey(installId, keypair.publicKey);
  });

  describe('DeviceKeyStore contract', () => {
    it('returns null for an unknown install and the stored PEM afterwards', async () => {
      const custom = new InMemoryDeviceKeyStore();

      await expect(custom.getPublicKey('nope')).resolves.toBeNull();

      await custom.setPublicKey('id', 'pem-value');
      await expect(custom.getPublicKey('id')).resolves.toBe('pem-value');
    });

    it('overwrites an existing key (install re-enrolment)', async () => {
      const custom = new InMemoryDeviceKeyStore();
      await custom.setPublicKey('id', 'first');
      await custom.setPublicKey('id', 'second');

      await expect(custom.getPublicKey('id')).resolves.toBe('second');
    });

    it('is satisfied by any object implementing get/set', async () => {
      const seen: string[] = [];
      const fake: DeviceKeyStore = {
        getPublicKey: async (id: string) => {
          seen.push(id);
          return keypair.publicKey;
        },
        setPublicKey: async () => undefined,
      };

      const mw = createDeviceSignatureMiddleware({ keyStore: fake, replayCache });
      const recorder = makeRecorder();

      await mw(makeRequest({ installId, privateKey: keypair.privateKey }), noopResponse, recorder.next);

      expect(seen).toEqual([installId]);
      expect(recorder.errors).toHaveLength(0);
    });
  });

  describe('DeviceAuthContext / AuthenticatedDeviceRequest', () => {
    it('leaves deviceAuth unset until the signature verifies', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const req = makeRequest({ installId: 'unknown_install', privateKey: keypair.privateKey });
      const recorder = makeRecorder();

      await mw(req, noopResponse, recorder.next);

      expect((req as AuthenticatedDeviceRequest).deviceAuth).toBeUndefined();
      expect(recorder.errors[0].code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it('attaches exactly { installId, publicKey } on success', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const req = makeRequest({ installId, privateKey: keypair.privateKey });
      const recorder = makeRecorder();

      await mw(req, noopResponse, recorder.next);

      expect(recorder.errors).toHaveLength(0);
      const deviceAuth = (req as AuthenticatedDeviceRequest).deviceAuth;
      expect(deviceAuth).toEqual({ installId, publicKey: keypair.publicKey });
      expect(Object.keys(deviceAuth as object).sort()).toEqual(['installId', 'publicKey']);
    });

    it('increments the mobile.sig.verified metric once on success', async () => {
      const spy = jest.spyOn(globalMetrics, 'incrementCounter').mockImplementation(() => undefined);
      try {
        const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
        const recorder = makeRecorder();

        await mw(
          makeRequest({ installId, privateKey: keypair.privateKey }),
          noopResponse,
          recorder.next,
        );

        expect(spy).toHaveBeenCalledWith(
          'mobile.sig.verified',
          { installId },
          1,
          expect.any(String),
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('header validation', () => {
    it.each(REQUIRED_HEADERS)('rejects a request missing %s', async (header) => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, omitHeader: header }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors).toHaveLength(1);
      expect(recorder.errors[0].code).toBe(ErrorCode.BAD_REQUEST);
      expect(recorder.errors[0].message).toContain('Missing required device signature headers');
      for (const name of REQUIRED_HEADERS) {
        expect(recorder.errors[0].message).toContain(name);
      }
    });

    it('does not consult the key store when headers are missing', async () => {
      const getPublicKey = jest.fn(async () => keypair.publicKey);
      const mw = createDeviceSignatureMiddleware({
        keyStore: { getPublicKey, setPublicKey: async () => undefined },
        replayCache,
      });
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, omitHeader: 'X-Device-Nonce' }),
        noopResponse,
        recorder.next,
      );

      expect(getPublicKey).not.toHaveBeenCalled();
    });
  });

  describe('timestamp boundaries', () => {
    it('rejects a timestamp too far in the future (symmetric skew check)', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache, clockSkewMs: 5_000 });
      const future = new Date(Date.now() + 30_000).toISOString();
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, timestamp: future }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors[0].code).toBe(ErrorCode.BAD_REQUEST);
      expect(recorder.errors[0].message).toContain('clock-skew');
    });

    it('accepts a timestamp inside the skew window', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache, clockSkewMs: 60_000 });
      const slightlyOld = new Date(Date.now() - 30_000).toISOString();
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, timestamp: slightlyOld }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors).toHaveLength(0);
    });
  });

  describe('signature verification failures', () => {
    it('rejects a signature produced over a different body', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const recorder = makeRecorder();

      await mw(
        makeRequest({
          installId,
          privateKey: keypair.privateKey,
          body: { amount: '10' },
          signedBody: { amount: '1000000' },
        }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors[0].code).toBe(ErrorCode.UNAUTHORIZED);
      expect(recorder.errors[0].message).toContain('Invalid device signature');
    });

    it('rejects a signature produced for a different HTTP method', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, method: 'POST', signedMethod: 'GET' }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors[0].code).toBe(ErrorCode.UNAUTHORIZED);
      expect(recorder.errors[0].message).toContain('Invalid device signature');
    });

    it('rejects a signature made with an unrelated private key', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const recorder = makeRecorder();

      await mw(
        makeRequest({ installId, privateKey: otherKeypair.privateKey }),
        noopResponse,
        recorder.next,
      );

      expect(recorder.errors[0].message).toContain('Invalid device signature');
    });

    it('rejects when the stored public key is not a usable PEM', async () => {
      await store.setPublicKey(installId, 'not-a-pem');
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const recorder = makeRecorder();

      await mw(makeRequest({ installId, privateKey: keypair.privateKey }), noopResponse, recorder.next);

      expect(recorder.errors).toHaveLength(1);
      expect(recorder.errors[0].code).toBe(ErrorCode.UNAUTHORIZED);
      expect(recorder.errors[0].message).toContain('Invalid device signature');
    });
  });

  describe('replay protection', () => {
    it('rejects a replayed (install, timestamp, nonce) tuple', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });
      const timestamp = new Date().toISOString();
      const signed = { installId, privateKey: keypair.privateKey, timestamp, nonce: 'replay-nonce' };

      const first = makeRecorder();
      await mw(makeRequest(signed), noopResponse, first.next);
      expect(first.errors).toHaveLength(0);

      const second = makeRecorder();
      await mw(makeRequest(signed), noopResponse, second.next);
      expect(second.errors[0].message).toContain('Replay detected');
    });

    it('treats the same nonce at a different timestamp as a distinct request', async () => {
      const mw = createDeviceSignatureMiddleware({ keyStore: store, replayCache });

      const first = makeRecorder();
      await mw(
        makeRequest({
          installId,
          privateKey: keypair.privateKey,
          nonce: 'shared-nonce',
          timestamp: new Date(Date.now() - 1_000).toISOString(),
        }),
        noopResponse,
        first.next,
      );
      expect(first.errors).toHaveLength(0);

      const second = makeRecorder();
      await mw(
        makeRequest({ installId, privateKey: keypair.privateKey, nonce: 'shared-nonce' }),
        noopResponse,
        second.next,
      );
      expect(second.errors).toHaveLength(0);
    });

    it('honours an injected replay cache that reports a hit', async () => {
      const mw = createDeviceSignatureMiddleware({
        keyStore: store,
        replayCache: { seen: () => true },
      });
      const recorder = makeRecorder();

      await mw(makeRequest({ installId, privateKey: keypair.privateKey }), noopResponse, recorder.next);

      expect(recorder.errors[0].code).toBe(ErrorCode.BAD_REQUEST);
      expect(recorder.errors[0].message).toContain('Replay detected');
    });
  });

  describe('key store failures', () => {
    it('surfaces a store rejection as a 500 INTERNAL_ERROR', async () => {
      const mw = createDeviceSignatureMiddleware({
        keyStore: {
          getPublicKey: async () => {
            throw new Error('postgres connection reset');
          },
          setPublicKey: async () => undefined,
        },
        replayCache,
      });
      const recorder = makeRecorder();

      await mw(makeRequest({ installId, privateKey: keypair.privateKey }), noopResponse, recorder.next);

      expect(recorder.errors).toHaveLength(1);
      expect(recorder.errors[0].code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(recorder.errors[0].statusCode).toBe(500);
      expect(recorder.errors[0].message).toBe('postgres connection reset');
    });

    it('never attaches deviceAuth when the store fails', async () => {
      const mw = createDeviceSignatureMiddleware({
        keyStore: {
          getPublicKey: async () => {
            throw new Error('store offline');
          },
          setPublicKey: async () => undefined,
        },
        replayCache,
      });
      const req = makeRequest({ installId, privateKey: keypair.privateKey });
      const recorder = makeRecorder();

      await mw(req, noopResponse, recorder.next);

      expect((req as AuthenticatedDeviceRequest).deviceAuth).toBeUndefined();
    });

    it('uses a generic message when the store throws a non-Error value', async () => {
      const mw = createDeviceSignatureMiddleware({
        keyStore: {
          getPublicKey: async () => {
            throw 'boom';
          },
          setPublicKey: async () => undefined,
        },
        replayCache,
      });
      const recorder = makeRecorder();

      await mw(makeRequest({ installId, privateKey: keypair.privateKey }), noopResponse, recorder.next);

      expect(recorder.errors[0].message).toBe('Device signature verification failed');
    });
  });

  describe('InMemoryReplayCache contract', () => {
    it('reports the first sighting as new and the second as seen', () => {
      const cache = new InMemoryReplayCache();

      expect(cache.seen('install:ts:nonce')).toBe(false);
      expect(cache.seen('install:ts:nonce')).toBe(true);
    });

    it('keeps separate keys independent', () => {
      const cache = new InMemoryReplayCache();
      cache.seen('a');

      expect(cache.seen('b')).toBe(false);
      expect(cache.seen('a')).toBe(true);
    });

    it('falls back to the default window when maxAgeMs is undefined', () => {
      const cache = new InMemoryReplayCache();

      expect(cache.seen('key', undefined)).toBe(false);
      expect(cache.seen('key', undefined)).toBe(true);
    });
  });
});
