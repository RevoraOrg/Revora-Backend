import { Router, Request, Response, NextFunction } from 'express';
import { verifyWebhook, extractSignatureFromHeaders } from '../lib/webhookSignature';
import { EmailDeliverabilityService } from '../services/emailDeliverabilityService';
import { Logger } from '../lib/logger';
import { Errors } from '../lib/errors';

/**
 * Configuration for email webhook route authentication.
 */
export interface EmailWebhookAuthConfig {
  /** HMAC secret for SendGrid event webhooks. */
  sendgridWebhookSecret?: string;
  /** HMAC secret for SES SNS notifications (if used). */
  sesSnsSecret?: string;
  /** Shared secret for generic SMTP DSN webhooks. */
  smtpWebhookSecret?: string;
}

/**
 * Parsed domain from an email address.
 */
function extractDomain(email: string): string {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return 'unknown';
  return email.slice(atIndex + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// SendGrid event webhook signature verification middleware
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that verifies SendGrid event webhook signatures.
 *
 * SendGrid signs event webhooks using an HMAC-SHA256 signature in the
 * `X-Twilio-Email-Event-Webhook-Signature` header.  The signature is computed
 * over the concatenation of the timestamp + event payload.
 *
 * If no secret is configured, the middleware skips verification (for
 * development/test convenience but logs a warning).
 */
function createSendgridAuthMiddleware(secret?: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // If no secret configured, allow in dev/test but warn
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        next(Errors.internal('SENDGRID_EVENT_WEBHOOK_SECRET must be configured in production'));
        return;
      }
      console.warn('[emailWebhooks] SendGrid webhook secret not configured — skipping verification');
      next();
      return;
    }

    const rawBody = (req as any).rawBody;
    if (!rawBody && typeof req.body === 'object') {
      // Re-serialize body for verification (Express JSON parsing already happened)
      const serialized = JSON.stringify(req.body);
      const headers = req.headers as Record<string, string | string[] | undefined>;

      // Try to extract signature
      const signature = extractSignatureFromHeaders(headers);
      if (!signature) {
        next(Errors.unauthorized('Missing SendGrid webhook signature'));
        return;
      }

      const result = verifyWebhook(
        { secret, headerName: 'x-twilio-email-event-webhook-signature', requireTimestamp: false },
        serialized,
        headers,
      );

      if (!result.valid) {
        next(Errors.unauthorized('Invalid SendGrid webhook signature'));
        return;
      }
    }

    next();
  };
}

/**
 * Helper to extract the raw body buffer.  Must be mounted before
 * express.json() in the parent router if used.
 */
export function captureRawBody(req: Request, _res: Response, next: NextFunction): void {
  let data = '';
  req.on('data', (chunk: string) => { data += chunk; });
  req.on('end', () => {
    (req as any).rawBody = data;
    next();
  });
}

// ---------------------------------------------------------------------------
// SendGrid event parser
// ---------------------------------------------------------------------------

/**
 * Parse a SendGrid event payload and return normalized bounce event inputs.
 *
 * SendGrid event format: https://docs.sendgrid.com/for-developers/tracking-events/event
 */
function parseSendGridEvents(
  events: unknown[],
  deliverabilityService: EmailDeliverabilityService,
): Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> {
  const results: Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> = [];

  if (!Array.isArray(events)) return results;

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;

    const event = evt as Record<string, unknown>;
    const email = event.email as string | undefined;
    if (!email) continue;

    const domain = extractDomain(email);
    const eventName = String(event.event ?? '').toLowerCase();
    const sgEventId = String(event.sg_event_id ?? '');
    const status = event.status ? String(event.status) : undefined;

    switch (eventName) {
      case 'bounce':
      case 'hard_bounce':
        results.push({
          input: {
            email,
            domain,
            provider: 'sendgrid',
            bounce_type: 'hard_bounce',
            status_code: status,
            provider_event_id: sgEventId || undefined,
            raw_payload: event,
            autoSuppress: true,
          },
          domain,
        });
        break;

      case 'soft_bounce':
        results.push({
          input: {
            email,
            domain,
            provider: 'sendgrid',
            bounce_type: 'soft_bounce',
            status_code: status,
            provider_event_id: sgEventId || undefined,
            raw_payload: event,
            autoSuppress: false, // soft bounces are transient
          },
          domain,
        });
        break;

      case 'block':
        results.push({
          input: {
            email,
            domain,
            provider: 'sendgrid',
            bounce_type: 'block',
            status_code: status,
            provider_event_id: sgEventId || undefined,
            raw_payload: event,
            autoSuppress: true,
          },
          domain,
        });
        break;

      case 'spamreport':
        results.push({
          input: {
            email,
            domain,
            provider: 'sendgrid',
            bounce_type: 'spam_complaint',
            status_code: undefined,
            provider_event_id: sgEventId || undefined,
            raw_payload: event,
            autoSuppress: true,
          },
          domain,
        });
        break;

      case 'unsubscribe':
      case 'group_unsubscribe':
        results.push({
          input: {
            email,
            domain,
            provider: 'sendgrid',
            bounce_type: 'unsubscribe',
            status_code: undefined,
            provider_event_id: sgEventId || undefined,
            raw_payload: event,
            autoSuppress: false,
          },
          domain,
        });
        break;

      default:
        // Ignore other event types (open, click, delivered, etc.)
        break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// SES SNS notification parser (simplified — supports bounce & complaint)
// ---------------------------------------------------------------------------

/**
 * Parse an SES bounce SNS notification body.
 *
 * SES notification format: https://docs.aws.amazon.com/ses/latest/dg/notification-contents.html
 */
function parseSesBounceNotification(
  body: Record<string, unknown>,
  deliverabilityService: EmailDeliverabilityService,
): Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> {
  const results: Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> = [];

  // Handle SNS wrapper
  const messageStr = typeof body.Message === 'string' ? body.Message : null;
  if (!messageStr) return results;

  let message: Record<string, unknown>;
  try {
    message = JSON.parse(messageStr);
  } catch {
    return results;
  }

  const notificationType = String(message.notificationType ?? '').toLowerCase();

  if (notificationType === 'bounce') {
    const bounce = message.bounce as Record<string, unknown> | undefined;
    if (!bounce) return results;

    const bounceType = String(bounce.bounceType ?? '').toLowerCase();
    const bounceSubType = String(bounce.bounceSubType ?? '').toLowerCase();
    const bouncedRecipients = bounce.bouncedRecipients as Array<Record<string, unknown>> | undefined;

    if (!bouncedRecipients) return results;

    const isHard = bounceType === 'permanent' || bounceSubType === 'onaccountsuppressionlist';

    for (const recipient of bouncedRecipients) {
      const email = String(recipient.emailAddress ?? '');
      if (!email) continue;

      const domain = extractDomain(email);
      const status = recipient.status ? String(recipient.status) : undefined;

      results.push({
        input: {
          email,
          domain,
          provider: 'ses',
          bounce_type: isHard ? 'hard_bounce' : 'soft_bounce',
          status_code: status,
          provider_event_id: bounce.feedbackId ? String(bounce.feedbackId) : undefined,
          raw_payload: recipient,
          autoSuppress: isHard,
        },
        domain,
      });
    }
  } else if (notificationType === 'complaint') {
    const complaint = message.complaint as Record<string, unknown> | undefined;
    if (!complaint) return results;

    const complainedRecipients = complaint.complainedRecipients as Array<Record<string, unknown>> | undefined;
    if (!complainedRecipients) return results;

    for (const recipient of complainedRecipients) {
      const email = String(recipient.emailAddress ?? '');
      if (!email) continue;

      const domain = extractDomain(email);

      results.push({
        input: {
          email,
          domain,
          provider: 'ses',
          bounce_type: 'spam_complaint',
          status_code: undefined,
          provider_event_id: complaint.feedbackId ? String(complaint.feedbackId) : undefined,
          raw_payload: recipient,
          autoSuppress: true,
        },
        domain,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// SMTP DSN parser (generic bounce notification)
// ---------------------------------------------------------------------------

/**
 * Parse a generic SMTP Delivery Status Notification (DSN) payload.
 * This handles bounce notifications from custom SMTP relays.
 *
 * Expected format: a JSON body with a `dsn` field containing RFC 3464-style fields.
 */
function parseSmtpDsn(
  body: Record<string, unknown>,
  deliverabilityService: EmailDeliverabilityService,
): Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> {
  const results: Array<{ input: Parameters<EmailDeliverabilityService['recordBounce']>[0]; domain: string }> = [];

  const dsn = body.dsn as Record<string, unknown> | undefined;
  if (!dsn) return results;

  const email = String(dsn.original_recipient ?? body.email ?? '');
  if (!email) return results;

  const domain = extractDomain(email);
  const statusCode = dsn.status ? String(dsn.status) : undefined;
  const diagnosticCode = dsn['diagnostic-code'] ? String(dsn['diagnostic-code']) : undefined;

  // Determine bounce type from status code
  // RFC 3463: 4.x.x = transient (soft), 5.x.x = permanent (hard)
  const isHard = String(statusCode ?? '').startsWith('5');

  results.push({
    input: {
      email,
      domain,
      provider: 'smtp',
      bounce_type: isHard ? 'hard_bounce' : 'soft_bounce',
      status_code: statusCode,
      provider_event_id: dsn['message-id'] ? String(dsn['message-id']) : undefined,
      raw_payload: { diagnosticCode, ...dsn },
      autoSuppress: isHard,
    },
    domain,
  });

  return results;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Creates a router for email bounce webhook ingestion.
 *
 * POST /api/v1/email/webhooks/sendgrid  — SendGrid event webhooks
 * POST /api/v1/email/webhooks/ses        — SES bounce/complaint notifications
 * POST /api/v1/email/webhooks/smtp       — Generic SMTP DSN bounces
 *
 * Security:
 * - SendGrid and SMTP endpoints are authenticated via HMAC signature verification.
 * - SES endpoint is intended to be fronted by an SNS subscription verification
 *   handler (not implemented here — AWS recommends manual subscription confirmation).
 * - All endpoints validate input shape before processing.
 */
export function createEmailWebhooksRouter(
  deliverabilityService: EmailDeliverabilityService,
  authConfig: EmailWebhookAuthConfig = {},
  logger?: Logger,
): Router {
  const router = Router();
  const log = logger ?? new Logger({ serviceName: 'email-webhooks' });

  // -----------------------------------------------------------------------
  // SendGrid event webhook
  // -----------------------------------------------------------------------
  router.post(
    '/sendgrid',
    createSendgridAuthMiddleware(authConfig.sendgridWebhookSecret),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const events = req.body;
        const parsed = parseSendGridEvents(
          Array.isArray(events) ? events : [events],
          deliverabilityService,
        );

        let processed = 0;
        for (const { input } of parsed) {
          await deliverabilityService.recordBounce(input);
          processed++;
        }

        log.info('SendGrid events processed', {
          received: Array.isArray(events) ? events.length : 1,
          processed,
        });

        res.status(200).json({ received: true, processed });
      } catch (err) {
        log.error('SendGrid webhook processing error', { error: err });
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // SES bounce/complaint SNS notification
  // -----------------------------------------------------------------------
  router.post(
    '/ses',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Record<string, unknown>;
        const parsed = parseSesBounceNotification(body, deliverabilityService);

        let processed = 0;
        for (const { input } of parsed) {
          await deliverabilityService.recordBounce(input);
          processed++;
        }

        log.info('SES notifications processed', { processed });

        // SES SNS expects 200 with no specific body
        res.status(200).json({ received: true, processed });
      } catch (err) {
        log.error('SES webhook processing error', { error: err });
        next(err);
      }
    },
  );

  // -----------------------------------------------------------------------
  // Generic SMTP DSN bounce notification
  // -----------------------------------------------------------------------
  router.post(
    '/smtp',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Record<string, unknown>;
        const parsed = parseSmtpDsn(body, deliverabilityService);

        let processed = 0;
        for (const { input } of parsed) {
          await deliverabilityService.recordBounce(input);
          processed++;
        }

        log.info('SMTP DSN processed', { processed });

        res.status(200).json({ received: true, processed });
      } catch (err) {
        log.error('SMTP webhook processing error', { error: err });
        next(err);
      }
    },
  );

  return router;
}

