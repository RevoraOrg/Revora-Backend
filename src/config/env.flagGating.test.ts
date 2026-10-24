/**
 * Startup wiring regression tests for boolean feature flags — issue #1305.
 *
 * `EMAIL_DELIVERABILITY_ENABLED` gates construction of the deliverability
 * service and mounting of the `/api/v1/email/webhooks/*` routes in
 * `src/index.ts` (`if (env.EMAIL_DELIVERABILITY_ENABLED) { ... }`).
 *
 * Under `z.coerce.boolean()` the strings `"false"`, `"0"` and `"off"` all
 * parsed as `true`, so an operator could never disable the SendGrid/SES/SMTP
 * webhook ingestion endpoints. These tests boot the real Express app with the
 * flag set to each accepted value and assert the routes are absent (404 from
 * the global not-found handler) or mounted (200).
 *
 * The SNS SubscriptionConfirmation path is used as the probe because it is
 * answered with a static 200 and never touches the database.
 */
import request from 'supertest';
import type { Express } from 'express';

const FLAG = 'EMAIL_DELIVERABILITY_ENABLED';

async function loadAppWithFlag(value: string): Promise<Express> {
  jest.resetModules();
  process.env[FLAG] = value;
  const mod = await import('../index');
  return mod.app;
}

function snsSubscriptionConfirmation(app: Express) {
  return request(app)
    .post('/api/v1/email/webhooks/ses')
    .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
    .send({
      Type: 'SubscriptionConfirmation',
      SubscribeURL: 'https://example.com/sns/confirm',
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:test-topic',
      Token: 'sns-confirm-token',
    });
}

describe('EMAIL_DELIVERABILITY_ENABLED route mounting (issue #1305)', () => {
  const originalFlag = process.env[FLAG];

  afterAll(() => {
    jest.resetModules();
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  it('does NOT mount deliverability webhooks when set to "off" (routes 404)', async () => {
    const app = await loadAppWithFlag('off');

    const res = await snsSubscriptionConfirmation(app);
    expect(res.status).toBe(404);
  });

  it('does NOT mount deliverability webhooks when set to "false" (regression: coerce mounted them)', async () => {
    const app = await loadAppWithFlag('false');

    const res = await snsSubscriptionConfirmation(app);
    expect(res.status).toBe(404);
  });

  it('mounts deliverability webhooks when set to "true"', async () => {
    const app = await loadAppWithFlag('true');

    const res = await snsSubscriptionConfirmation(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ received: true, type: 'SubscriptionConfirmation' });
  });
});
