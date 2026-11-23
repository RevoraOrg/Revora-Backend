import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { createEmailWebhooksRouter } from '../emailWebhooks';
import { EmailDeliverabilityService } from '../../services/emailDeliverabilityService';

// ---------------------------------------------------------------------------
// Helper: create a mock deliverability service
// ---------------------------------------------------------------------------

function createMockDeliverabilityService(): jest.Mocked<EmailDeliverabilityService> {
  const mock: Partial<jest.Mocked<EmailDeliverabilityService>> = {};
  mock.recordSend = jest.fn().mockResolvedValue(undefined);
  mock.recordBounce = jest.fn().mockResolvedValue(undefined);
  mock.recordAlignmentResult = jest.fn().mockResolvedValue(undefined);
  mock.isSuppressed = jest.fn().mockResolvedValue(false);
  mock.addSuppression = jest.fn().mockResolvedValue(undefined);
  mock.removeSuppression = jest.fn().mockResolvedValue(undefined);
  mock.getBounceRatio = jest.fn().mockResolvedValue(0);
  mock.getDomainMetrics = jest.fn().mockResolvedValue(null);
  mock.checkAlignmentAlarms = jest.fn().mockResolvedValue([]);
  mock.checkHighBounceRatioAlarms = jest.fn().mockResolvedValue([]);
  return mock as jest.Mocked<EmailDeliverabilityService>;
}

// ---------------------------------------------------------------------------
// Helper: sign a payload with HMAC-SHA256 (matches verifyWebhookPayload)
// ---------------------------------------------------------------------------
function signPayload(secret: string, payload: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  return `sha256=${hmac.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emailWebhooks Router', () => {
  let deliverabilityService: jest.Mocked<EmailDeliverabilityService>;

  function createApp(authConfig = {}) {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/email/webhooks',
      createEmailWebhooksRouter(deliverabilityService, authConfig),
    );
    return app;
  }

  beforeEach(() => {
    deliverabilityService = createMockDeliverabilityService();
  });

  // =========================================================================
  // SendGrid endpoint
  // =========================================================================
  describe('POST /sendgrid', () => {
    it('should process a hard bounce event', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          {
            email: 'bounce@example.com',
            event: 'bounce',
            sg_event_id: 'sg-123',
            status: '5.1.1',
            category: 'statement',
          },
        ]);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 1 });
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'bounce@example.com',
          domain: 'example.com',
          provider: 'sendgrid',
          bounce_type: 'hard_bounce',
          status_code: '5.1.1',
          provider_event_id: 'sg-123',
          autoSuppress: true,
        }),
      );
    });

    it('should process a spam report event', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          {
            email: 'spam@example.com',
            event: 'spamreport',
            sg_event_id: 'sg-spam-1',
          },
        ]);

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'spam@example.com',
          bounce_type: 'spam_complaint',
          autoSuppress: true,
        }),
      );
    });

    it('should process soft bounces without auto-suppression', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          {
            email: 'soft@example.com',
            event: 'soft_bounce',
            sg_event_id: 'sg-soft-1',
          },
        ]);

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          bounce_type: 'soft_bounce',
          autoSuppress: false,
        }),
      );
    });

    it('should process block events', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          {
            email: 'blocked@example.com',
            event: 'block',
            sg_event_id: 'sg-block-1',
          },
        ]);

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          bounce_type: 'block',
          autoSuppress: true,
        }),
      );
    });

    it('should process unsubscribe events', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          {
            email: 'unsub@example.com',
            event: 'group_unsubscribe',
            sg_event_id: 'sg-unsub-1',
          },
        ]);

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          bounce_type: 'unsubscribe',
          autoSuppress: false,
        }),
      );
    });

    it('should skip non-bounce events (open, click, delivered)', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          { email: 'user@example.com', event: 'open', sg_event_id: 'sg-open' },
          { email: 'user@example.com', event: 'click', sg_event_id: 'sg-click' },
          { email: 'user@example.com', event: 'delivered', sg_event_id: 'sg-delivered' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
      expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
    });

    it('should handle missing email field gracefully', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          { event: 'bounce', sg_event_id: 'sg-nomail' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
    });

    it('should handle non-array body', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send({ email: 'user@example.com', event: 'bounce' });

      expect(res.status).toBe(200);
      expect(res.body.processed).toBe(1);
    });

    // -----------------------------------------------------------------------
    // SendGrid auth: secret configured
    // -----------------------------------------------------------------------
    describe('with sendgridWebhookSecret configured', () => {
      const SECRET = 'sendgrid-test-secret-32-bytes!!!';

      it('should accept a request with a valid signature', async () => {
        const app = createApp({ sendgridWebhookSecret: SECRET });
        const payload = JSON.stringify([{ email: 'a@example.com', event: 'bounce', sg_event_id: 'sg-1' }]);
        const sig = signPayload(SECRET, payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/sendgrid')
          .set('x-twilio-email-event-webhook-signature', sig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.processed).toBe(1);
      });

      it('should reject a request with a missing signature header', async () => {
        const app = createApp({ sendgridWebhookSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/sendgrid')
          .send([{ email: 'a@example.com', event: 'bounce' }]);

        expect(res.status).toBe(401);
      });

      it('should reject a request with an invalid signature', async () => {
        const app = createApp({ sendgridWebhookSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/sendgrid')
          .set('x-twilio-email-event-webhook-signature', 'sha256=badhash')
          .send([{ email: 'a@example.com', event: 'bounce' }]);

        expect(res.status).toBe(401);
      });

      it('should reject a request signed with a different secret', async () => {
        const app = createApp({ sendgridWebhookSecret: SECRET });
        const payload = JSON.stringify([{ email: 'a@example.com', event: 'bounce' }]);
        const wrongSig = signPayload('wrong-secret-value-here-32bytes!', payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/sendgrid')
          .set('x-twilio-email-event-webhook-signature', wrongSig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(401);
      });
    });
  });

  // =========================================================================
  // SES endpoint
  // =========================================================================
  describe('POST /ses', () => {
    it('should process SES bounce notification', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .send({
          Message: JSON.stringify({
            notificationType: 'Bounce',
            bounce: {
              bounceType: 'Permanent',
              bounceSubType: 'General',
              feedbackId: 'ses-feedback-1',
              bouncedRecipients: [
                { emailAddress: 'bounce@example.com', status: '5.1.1' },
              ],
            },
          }),
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 1 });
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'bounce@example.com',
          domain: 'example.com',
          provider: 'ses',
          bounce_type: 'hard_bounce',
          autoSuppress: true,
        }),
      );
    });

    it('should process SES complaint notification', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .send({
          Message: JSON.stringify({
            notificationType: 'Complaint',
            complaint: {
              feedbackId: 'ses-complaint-1',
              complainedRecipients: [
                { emailAddress: 'spam@example.com' },
              ],
            },
          }),
        });

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'spam@example.com',
          bounce_type: 'spam_complaint',
          provider: 'ses',
          autoSuppress: true,
        }),
      );
    });

    it('should handle malformed SNS message gracefully', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .send({
          Message: 'invalid json',
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
    });

    it('should skip missing Message field', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
    });

    it('should handle soft bounce from SES', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .send({
          Message: JSON.stringify({
            notificationType: 'Bounce',
            bounce: {
              bounceType: 'Transient',
              feedbackId: 'ses-soft-1',
              bouncedRecipients: [
                { emailAddress: 'soft@example.com' },
              ],
            },
          }),
        });

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          bounce_type: 'soft_bounce',
          autoSuppress: false,
        }),
      );
    });

    // -----------------------------------------------------------------------
    // SNS SubscriptionConfirmation handling
    // -----------------------------------------------------------------------
    describe('SNS SubscriptionConfirmation', () => {
      it('should acknowledge SubscriptionConfirmation via x-amz-sns-message-type header', async () => {
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
          .send({
            Type: 'SubscriptionConfirmation',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
            Token: 'abc123token',
            SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=...&Token=abc123token',
          });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          received: true,
          type: 'SubscriptionConfirmation',
        });
        // Must NOT process it as a bounce/complaint event
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should acknowledge SubscriptionConfirmation via Type field in body', async () => {
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .send({
            Type: 'SubscriptionConfirmation',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
            Token: 'abc123token',
            SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
          });

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('SubscriptionConfirmation');
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should acknowledge SubscriptionConfirmation without SubscribeURL', async () => {
        // SubscribeURL may be absent in malformed requests — endpoint should still
        // return 200 and not throw, to prevent AWS from retrying.
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
          .send({
            Type: 'SubscriptionConfirmation',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
            // No Token or SubscribeURL
          });

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('SubscriptionConfirmation');
      });

      it('should acknowledge UnsubscribeConfirmation', async () => {
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-amz-sns-message-type', 'UnsubscribeConfirmation')
          .send({
            Type: 'UnsubscribeConfirmation',
            TopicArn: 'arn:aws:sns:us-east-1:123456789012:my-topic',
          });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          received: true,
          type: 'UnsubscribeConfirmation',
        });
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should not auto-confirm the subscription (no HTTP call to SubscribeURL)', async () => {
        // The response body should only acknowledge receipt, not indicate
        // that the subscription was automatically confirmed.
        const app = createApp();

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
          .send({
            Type: 'SubscriptionConfirmation',
            SubscribeURL: 'https://sns.aws.example.com/confirm',
            Token: 'tok123',
            TopicArn: 'arn:aws:sns:us-east-1:999:topic',
          });

        expect(res.status).toBe(200);
        // The message should indicate manual confirmation is required
        expect(res.body.message).toMatch(/manual/i);
        // The response should NOT include a 'confirmed: true' field
        expect(res.body).not.toHaveProperty('confirmed', true);
      });
    });

    // -----------------------------------------------------------------------
    // SES auth: sesSnsSecret configured
    // -----------------------------------------------------------------------
    describe('with sesSnsSecret configured', () => {
      const SECRET = 'ses-test-secret-32-bytes!!!!!!!!';

      it('should accept a request with a valid signature', async () => {
        const app = createApp({ sesSnsSecret: SECRET });
        const body = {
          Message: JSON.stringify({
            notificationType: 'Bounce',
            bounce: {
              bounceType: 'Permanent',
              bouncedRecipients: [{ emailAddress: 'b@example.com' }],
            },
          }),
        };
        const payload = JSON.stringify(body);
        const sig = signPayload(SECRET, payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-revora-signature', sig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.processed).toBe(1);
      });

      it('should reject a request with a missing signature header', async () => {
        const app = createApp({ sesSnsSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .send({ Message: JSON.stringify({ notificationType: 'Bounce' }) });

        expect(res.status).toBe(401);
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should reject a request with an invalid signature', async () => {
        const app = createApp({ sesSnsSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-revora-signature', 'sha256=invalidsignature')
          .send({ Message: JSON.stringify({ notificationType: 'Bounce' }) });

        expect(res.status).toBe(401);
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should reject a request signed with a different secret', async () => {
        const app = createApp({ sesSnsSecret: SECRET });
        const payload = JSON.stringify({ Message: '{}' });
        const wrongSig = signPayload('completely-different-secret-!!!', payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-revora-signature', wrongSig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(401);
      });

      it('should authenticate SubscriptionConfirmation when secret is configured', async () => {
        const app = createApp({ sesSnsSecret: SECRET });
        const body = {
          Type: 'SubscriptionConfirmation',
          TopicArn: 'arn:aws:sns:us-east-1:123:topic',
          Token: 'tok',
          SubscribeURL: 'https://sns.example.com/confirm',
        };
        const payload = JSON.stringify(body);
        const sig = signPayload(SECRET, payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-revora-signature', sig)
          .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.type).toBe('SubscriptionConfirmation');
      });

      it('should reject unsigned SubscriptionConfirmation when secret is configured', async () => {
        const app = createApp({ sesSnsSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .set('x-amz-sns-message-type', 'SubscriptionConfirmation')
          .send({
            Type: 'SubscriptionConfirmation',
            SubscribeURL: 'https://sns.example.com/confirm',
          });

        expect(res.status).toBe(401);
      });

      it('should pass through when no secret is configured (unauthenticated allowed)', async () => {
        const app = createApp({}); // no sesSnsSecret

        const res = await request(app)
          .post('/api/v1/email/webhooks/ses')
          .send({
            Message: JSON.stringify({
              notificationType: 'Bounce',
              bounce: {
                bounceType: 'Permanent',
                bouncedRecipients: [{ emailAddress: 'x@example.com' }],
              },
            }),
          });

        expect(res.status).toBe(200);
      });
    });
  });

  // =========================================================================
  // SMTP DSN endpoint
  // =========================================================================
  describe('POST /smtp', () => {
    it('should process SMTP DSN for hard bounce', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/smtp')
        .send({
          dsn: {
            original_recipient: 'bounce@example.com',
            status: '5.1.1',
            'message-id': 'msg-123',
            'diagnostic-code': 'SMTP; 550 User unknown',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 1 });
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'bounce@example.com',
          domain: 'example.com',
          provider: 'smtp',
          bounce_type: 'hard_bounce',
          status_code: '5.1.1',
          autoSuppress: true,
        }),
      );
    });

    it('should process SMTP DSN for soft bounce (4.x.x)', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/smtp')
        .send({
          dsn: {
            original_recipient: 'soft@example.com',
            status: '4.7.1',
          },
        });

      expect(res.status).toBe(200);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledWith(
        expect.objectContaining({
          bounce_type: 'soft_bounce',
          autoSuppress: false,
        }),
      );
    });

    it('should handle missing DSN field', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/smtp')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
    });

    it('should handle missing recipient', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/smtp')
        .send({
          dsn: { status: '5.0.0' },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, processed: 0 });
    });

    // -----------------------------------------------------------------------
    // SMTP auth: smtpWebhookSecret configured
    // -----------------------------------------------------------------------
    describe('with smtpWebhookSecret configured', () => {
      const SECRET = 'smtp-test-secret-32-bytes!!!!!!!';

      it('should accept a request with a valid signature', async () => {
        const app = createApp({ smtpWebhookSecret: SECRET });
        const body = {
          dsn: { original_recipient: 'user@example.com', status: '5.1.1' },
        };
        const payload = JSON.stringify(body);
        const sig = signPayload(SECRET, payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/smtp')
          .set('x-revora-signature', sig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.processed).toBe(1);
      });

      it('should reject a request with a missing signature header', async () => {
        const app = createApp({ smtpWebhookSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/smtp')
          .send({ dsn: { original_recipient: 'user@example.com', status: '5.0.0' } });

        expect(res.status).toBe(401);
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should reject a request with an invalid signature', async () => {
        const app = createApp({ smtpWebhookSecret: SECRET });

        const res = await request(app)
          .post('/api/v1/email/webhooks/smtp')
          .set('x-revora-signature', 'sha256=badhexvalue')
          .send({ dsn: { original_recipient: 'user@example.com', status: '5.0.0' } });

        expect(res.status).toBe(401);
        expect(deliverabilityService.recordBounce).not.toHaveBeenCalled();
      });

      it('should reject a request signed with a different secret', async () => {
        const app = createApp({ smtpWebhookSecret: SECRET });
        const payload = JSON.stringify({ dsn: { original_recipient: 'u@x.com', status: '5.0.0' } });
        const wrongSig = signPayload('wrong-secret-value-here-32bytes!', payload);

        const res = await request(app)
          .post('/api/v1/email/webhooks/smtp')
          .set('x-revora-signature', wrongSig)
          .set('Content-Type', 'application/json')
          .send(payload);

        expect(res.status).toBe(401);
      });

      it('should pass through when no secret is configured (unauthenticated allowed)', async () => {
        const app = createApp({}); // no smtpWebhookSecret

        const res = await request(app)
          .post('/api/v1/email/webhooks/smtp')
          .send({
            dsn: { original_recipient: 'user@example.com', status: '5.0.0' },
          });

        expect(res.status).toBe(200);
      });
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('error handling', () => {
    it('should return 500 and not crash when service throws', async () => {
      deliverabilityService.recordBounce.mockRejectedValue(new Error('DB error'));
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([{ email: 'fail@example.com', event: 'bounce' }]);

      expect(res.status).toBe(500);
    });

    it('should handle multiple events in batch', async () => {
      const app = createApp();

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .send([
          { email: 'a@example.com', event: 'bounce', sg_event_id: 'sg-1' },
          { email: 'b@example.com', event: 'bounce', sg_event_id: 'sg-2' },
          { email: 'c@example.com', event: 'spamreport', sg_event_id: 'sg-3' },
        ]);

      expect(res.status).toBe(200);
      expect(res.body.processed).toBe(3);
      expect(deliverabilityService.recordBounce).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // EmailWebhookAuthConfig: independent secret isolation
  // =========================================================================
  describe('EmailWebhookAuthConfig secret isolation', () => {
    const SG_SECRET = 'sendgrid-secret-32-bytes!!!!!!!!!';
    const SES_SECRET = 'ses-secret-32-bytes!!!!!!!!!!!!!!';
    const SMTP_SECRET = 'smtp-secret-32-bytes!!!!!!!!!!!!!';

    it('should enforce auth independently per endpoint — SES secret does not unlock SendGrid', async () => {
      const app = createApp({ sendgridWebhookSecret: SG_SECRET, sesSnsSecret: SES_SECRET });
      const payload = JSON.stringify([{ email: 'a@example.com', event: 'bounce' }]);

      // Sign with the SES secret (wrong for SendGrid)
      const sesSig = signPayload(SES_SECRET, payload);

      const res = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .set('x-twilio-email-event-webhook-signature', sesSig)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('should enforce auth independently per endpoint — SMTP secret does not unlock SES', async () => {
      const app = createApp({ sesSnsSecret: SES_SECRET, smtpWebhookSecret: SMTP_SECRET });
      const payload = JSON.stringify({ Message: JSON.stringify({ notificationType: 'Bounce' }) });

      // Sign with SMTP secret (wrong for SES)
      const smtpSig = signPayload(SMTP_SECRET, payload);

      const res = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .set('x-revora-signature', smtpSig)
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('should allow all three endpoints when all secrets are valid', async () => {
      const app = createApp({
        sendgridWebhookSecret: SG_SECRET,
        sesSnsSecret: SES_SECRET,
        smtpWebhookSecret: SMTP_SECRET,
      });

      // SendGrid
      const sgPayload = JSON.stringify([{ email: 'a@example.com', event: 'bounce', sg_event_id: 'x' }]);
      const sgSig = signPayload(SG_SECRET, sgPayload);
      const sgRes = await request(app)
        .post('/api/v1/email/webhooks/sendgrid')
        .set('x-twilio-email-event-webhook-signature', sgSig)
        .set('Content-Type', 'application/json')
        .send(sgPayload);
      expect(sgRes.status).toBe(200);

      // SES
      const sesBody = { Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'b@example.com' }] } }) };
      const sesPayload = JSON.stringify(sesBody);
      const sesSig = signPayload(SES_SECRET, sesPayload);
      const sesRes = await request(app)
        .post('/api/v1/email/webhooks/ses')
        .set('x-revora-signature', sesSig)
        .set('Content-Type', 'application/json')
        .send(sesPayload);
      expect(sesRes.status).toBe(200);

      // SMTP
      const smtpBody = { dsn: { original_recipient: 'c@example.com', status: '5.0.0' } };
      const smtpPayload = JSON.stringify(smtpBody);
      const smtpSig = signPayload(SMTP_SECRET, smtpPayload);
      const smtpRes = await request(app)
        .post('/api/v1/email/webhooks/smtp')
        .set('x-revora-signature', smtpSig)
        .set('Content-Type', 'application/json')
        .send(smtpPayload);
      expect(smtpRes.status).toBe(200);
    });
  });
});
