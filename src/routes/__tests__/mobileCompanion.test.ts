import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createMobileCompanionRouter } from '../mobileCompanion';
import {
  InMemoryDeviceKeyStore,
  InMemoryReplayCache,
  generateEd25519Keypair,
  hashBody,
  buildSignaturePayload,
} from '../../middleware/deviceSignature';

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

describe('Mobile Companion Routes', () => {
  let app: express.Express;
  let keyStore: InMemoryDeviceKeyStore;
  let keypair: ReturnType<typeof generateEd25519Keypair>;

  beforeEach(() => {
    keyStore = new InMemoryDeviceKeyStore();
    keypair = generateEd25519Keypair();

    app = express();
    app.use(express.json());
    app.use('/api/v1/mobile', createMobileCompanionRouter({ keyStore }));
  });

  describe('POST /enroll', () => {
    it('should return 400 when publicKey is missing', async () => {
      const res = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('publicKey');
    });

    it('should return 400 when publicKey is not a string', async () => {
      const res = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({ publicKey: 123 });
      expect(res.status).toBe(400);
    });

    it('should return 400 when publicKey is not Ed25519 PEM', async () => {
      const res = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({ publicKey: 'not-a-real-key' });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Ed25519');
    });

    it('should return 201 with installId for valid Ed25519 public key', async () => {
      const res = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({ publicKey: keypair.publicKey });
      expect(res.status).toBe(201);
      expect(res.body.installId).toBeDefined();
      expect(typeof res.body.installId).toBe('string');
    });

    it('should store the public key retrievable for the install ID', async () => {
      const enrollRes = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({ publicKey: keypair.publicKey });

      const stored = await keyStore.getPublicKey(enrollRes.body.installId);
      expect(stored).toBe(keypair.publicKey);
    });
  });

  describe('GET /ping (authenticated)', () => {
    let installId: string;

    beforeEach(async () => {
      const enrollRes = await request(app)
        .post('/api/v1/mobile/enroll')
        .send({ publicKey: keypair.publicKey });
      installId = enrollRes.body.installId;
    });

    it('should return 400 without device signature headers', async () => {
      const res = await request(app).get('/api/v1/mobile/ping');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
    });

    it('should return 401 for unknown install ID', async () => {
      const now = new Date().toISOString();
      const sig = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, now, 'nonce-x');
      const res = await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', 'nonexistent')
        .set('x-device-timestamp', now)
        .set('x-device-nonce', 'nonce-x')
        .set('x-device-signature', sig);
      expect(res.status).toBe(401);
    });

    it('should return 401 for invalid signature', async () => {
      const now = new Date().toISOString();
      const res = await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now)
        .set('x-device-nonce', 'bad-sig-nonce')
        .set('x-device-signature', 'invalidsignaturebase64');
      expect(res.status).toBe(401);
    });

    it('should return 200 with installId for valid signature', async () => {
      const now = new Date().toISOString();
      const sig = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, now, 'valid-ping-nonce');
      const res = await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now)
        .set('x-device-nonce', 'valid-ping-nonce')
        .set('x-device-signature', sig);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.installId).toBe(installId);
    });

    it('should reject replayed nonce', async () => {
      const now = new Date().toISOString();
      const sig = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, now, 'replay-nonce');

      await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now)
        .set('x-device-nonce', 'replay-nonce')
        .set('x-device-signature', sig)
        .expect(200);

      const res = await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now)
        .set('x-device-nonce', 'replay-nonce')
        .set('x-device-signature', sig);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Replay');
    });

    it('should reject expired timestamp', async () => {
      const oldTime = new Date(Date.now() - 200_000).toISOString();
      const sig = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, oldTime, 'stale-nonce');
      const res = await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', oldTime)
        .set('x-device-nonce', 'stale-nonce')
        .set('x-device-signature', sig);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('clock-skew');
    });

    it('should allow two different nonces from the same device', async () => {
      const now1 = new Date().toISOString();
      const sig1 = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, now1, 'unique-nonce-1');
      await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now1)
        .set('x-device-nonce', 'unique-nonce-1')
        .set('x-device-signature', sig1)
        .expect(200);

      const now2 = new Date().toISOString();
      const sig2 = signRequest(keypair.privateKey, 'GET', '/api/v1/mobile/ping', undefined, now2, 'unique-nonce-2');
      await request(app)
        .get('/api/v1/mobile/ping')
        .set('x-device-install-id', installId)
        .set('x-device-timestamp', now2)
        .set('x-device-nonce', 'unique-nonce-2')
        .set('x-device-signature', sig2)
        .expect(200);
    });
  });
});
