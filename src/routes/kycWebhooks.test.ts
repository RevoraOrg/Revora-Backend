import express from 'express';
import request from 'supertest';
import { createKycWebhookRouter } from './kycWebhooks';
import { signWebhookPayload } from '../lib/webhookSignature';

const PRIMARY = 'kyc-primary-secret-key-32bytes!!';
const NEXT = 'kyc-next-secret-key-32bytes!!!!!!';

function buildApp(authOptions?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use(
    '/webhooks/kyc',
    createKycWebhookRouter({
      authOptions: {
        secret: PRIMARY,
        nextSecret: NEXT,
        nextSecretExpiry: Date.now() + 86_400_000,
        ...authOptions,
      },
    })
  );
  return app;
}

describe('KYC webhook route (dual-key)', () => {
  const payload = { id: 'evt-1', event: 'kyc.approved', data: { investorId: 'i-1' } };

  it('accepts a payload signed with the current key', async () => {
    const app = buildApp();
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post('/webhooks/kyc')
      .set('x-revora-signature', signWebhookPayload(PRIMARY, body))
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('accepts a payload signed with the next key inside the window', async () => {
    const app = buildApp();
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post('/webhooks/kyc')
      .set('x-revora-signature', signWebhookPayload(NEXT, body))
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
  });

  it('rejects next-key deliveries after the hard deadline', async () => {
    const app = buildApp({ nextSecretExpiry: Date.now() - 1000 });
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post('/webhooks/kyc')
      .set('x-revora-signature', signWebhookPayload(NEXT, body))
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(403);
  });

  it('throws when next key is configured without an expiry', () => {
    expect(() =>
      createKycWebhookRouter({
        authOptions: { secret: PRIMARY, nextSecret: NEXT },
      })
    ).toThrow(/KYC_WEBHOOK_KEY_NEXT_EXPIRY/);
  });
});
