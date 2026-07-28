import express from 'express';
import request from 'supertest';
import { createEmailWebhooksRouter } from '../emailWebhooks';
import { EmailDeliverabilityService } from '../../services/emailDeliverabilityService';
import { MetricsCollector } from '../../lib/metrics';
import { EmailDeliverabilityRepository } from '../../db/repositories/emailDeliverabilityRepository';
import type { BounceEvent, DomainDeliverability } from '../../db/repositories/emailDeliverabilityRepository';

// ---------------------------------------------------------------------------
// Helper: create a mock repo & service
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
// Tests
// ---------------------------------------------------------------------------

describe('emailWebhooks Router', () => {
  let deliverabilityService: jest.Mocked<EmailDeliverabilityService>;

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1/email/webhooks',
      createEmailWebhooksRouter(deliverabilityService, {}),
    );
    return app;
  }

  beforeEach(() => {
    deliverabilityService = createMockDeliverabilityService();
  });

  // -----------------------------------------------------------------------
  // SendGrid endpoint
  // -----------------------------------------------------------------------
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
  });

  // -----------------------------------------------------------------------
  // SES endpoint
  // -----------------------------------------------------------------------
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
  });

  // -----------------------------------------------------------------------
  // SMTP DSN endpoint
  // -----------------------------------------------------------------------
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
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
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
});

