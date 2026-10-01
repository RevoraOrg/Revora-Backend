import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createMobileCompanionRouter, __test } from '../mobileCompanion';
import type { MobileCompanionDependencies } from '../mobileCompanion';
import {
  InMemoryDeviceKeyStore,
  generateEd25519Keypair,
  hashBody,
  buildSignaturePayload,
} from '../../middleware/deviceSignature';
import type { DeviceKeyStore } from '../../middleware/deviceSignature';
import { errorHandler } from '../../middleware/errorHandler';

/**
 * Focused coverage for the `MobileCompanionDependencies` injection contract and
 * the `createMobileCompanionRouter` / `__test` surface.
 *
 * The existing suite exercises one router at a time. These tests pin what the
 * dependency object actually controls: whether two router instances share or
 * isolate device state, and how failures inside the injected key store surface.
 */

function signRequest(
  privateKey: string,
  method: string,
  path: string,
  body: unknown,
  timestamp: string,
  nonce: string,
): string {
  const bodyHash = hashBody(body);
  const payload = buildSignaturePayload(method, path, bodyHash, timestamp, nonce);
  const sig = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKey));
  return sig.toString('base64url');
}

function buildApp(deps?: MobileCompanionDependencies): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mobile', createMobileCompanionRouter(deps));
  app.use(errorHandler);
  return app;
}

const PING_PATH = '/api/v1/mobile/ping';

describe('MobileCompanionDependencies injection', () => {
  let keypair: ReturnType<typeof generateEd25519Keypair>;

  beforeEach(() => {
    keypair = generateEd25519Keypair();
  });

  it('exposes createMobileCompanionRouter through the __test surface', () => {
    expect(__test.createMobileCompanionRouter).toBe(createMobileCompanionRouter);
  });

  it('isolates device state between routers that receive no shared key store', async () => {
    const appA = buildApp();
    const appB = buildApp();

    const enroll = await request(appA)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: keypair.publicKey });
    expect(enroll.status).toBe(201);
    const installId = enroll.body.installId;

    const now = new Date().toISOString();
    const sig = signRequest(keypair.privateKey, 'GET', PING_PATH, undefined, now, 'iso-nonce');

    const res = await request(appB)
      .get(PING_PATH)
      .set('x-device-install-id', installId)
      .set('x-device-timestamp', now)
      .set('x-device-nonce', 'iso-nonce')
      .set('x-device-signature', sig);

    expect(res.status).toBe(401);
    expect(res.body.message).toContain('Unknown device install');
  });

  it('shares device state between routers that receive the same key store', async () => {
    const sharedStore = new InMemoryDeviceKeyStore();
    const appA = buildApp({ keyStore: sharedStore });
    const appB = buildApp({ keyStore: sharedStore });

    const enroll = await request(appA)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: keypair.publicKey });
    const installId = enroll.body.installId;

    const now = new Date().toISOString();
    const sig = signRequest(keypair.privateKey, 'GET', PING_PATH, undefined, now, 'shared-nonce');

    const res = await request(appB)
      .get(PING_PATH)
      .set('x-device-install-id', installId)
      .set('x-device-timestamp', now)
      .set('x-device-nonce', 'shared-nonce')
      .set('x-device-signature', sig);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', installId });
  });

  it('issues a distinct installId per enrollment and persists each public key', async () => {
    const keyStore = new InMemoryDeviceKeyStore();
    const app = buildApp({ keyStore });

    const second = generateEd25519Keypair();

    const first = await request(app)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: keypair.publicKey });
    const other = await request(app)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: second.publicKey });

    expect(first.status).toBe(201);
    expect(other.status).toBe(201);
    expect(first.body.installId).not.toBe(other.body.installId);

    expect(await keyStore.getPublicKey(first.body.installId)).toBe(keypair.publicKey);
    expect(await keyStore.getPublicKey(other.body.installId)).toBe(second.publicKey);
  });

  it('rejects a PEM that is not Ed25519 even when the SPKI header is present', async () => {
    const app = buildApp();
    const rsaPem =
      '-----BEGIN PUBLIC KEY-----\nRkFLRSBSU0EgS0VZIEJZVEVT\n-----END PUBLIC KEY-----';

    const res = await request(app)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: rsaPem });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.message).toContain('Ed25519');
  });

  it('rejects an enrollment with no request body', async () => {
    const app = buildApp();

    const res = await request(app).post('/api/v1/mobile/enroll').send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.message).toContain('publicKey');
  });

  it('surfaces a key-store write failure as a 500 without leaking an installId', async () => {
    const failingStore: DeviceKeyStore = {
      getPublicKey: async () => null,
      setPublicKey: async () => {
        throw new Error('store write failed');
      },
    };
    const app = buildApp({ keyStore: failingStore });

    const res = await request(app)
      .post('/api/v1/mobile/enroll')
      .send({ publicKey: keypair.publicKey });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('store write failed');
    expect(res.body).not.toHaveProperty('installId');
  });

  it('surfaces a key-store read failure during auth as a 500', async () => {
    const failingStore: DeviceKeyStore = {
      getPublicKey: async () => {
        throw new Error('store read failed');
      },
      setPublicKey: async () => undefined,
    };
    const app = buildApp({ keyStore: failingStore });

    const now = new Date().toISOString();
    const res = await request(app)
      .get(PING_PATH)
      .set('x-device-install-id', 'install_any')
      .set('x-device-timestamp', now)
      .set('x-device-nonce', 'read-failure-nonce')
      .set('x-device-signature', 'not-a-real-signature');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('store read failed');
  });
});
