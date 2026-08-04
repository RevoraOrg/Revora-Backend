/**
 * KYC vendor webhook receiver with dual-key signature rotation (#676).
 *
 * Mounts POST /webhooks/kyc protected by `kycWebhookAuth()`, which accepts
 * current + next keys during a hard-deadline rotation window and emits
 * `kyc.webhook.verified_by_key`.
 */

import { Router, Request, Response } from 'express';
import {
  kycWebhookAuth,
  WebhookAuthenticatedRequest,
} from '../middleware/webhookAuth';
import { globalLogger } from '../lib/logger';

export interface KycWebhookEvent {
  id: string;
  event: string;
  data: unknown;
  timestamp?: string;
}

export type KycWebhookHandler = (
  event: KycWebhookEvent,
  verifiedByKey: 'current' | 'next'
) => Promise<{ success: boolean; message: string }>;

const defaultHandler: KycWebhookHandler = async (event, verifiedByKey) => {
  globalLogger.info('KYC webhook received', {
    eventId: event.id,
    event: event.event,
    verifiedByKey,
  });
  return { success: true, message: `KYC event ${event.event} accepted` };
};

export interface KycWebhookRouterOptions {
  /** Optional override handler (defaults to structured log ack). */
  handler?: KycWebhookHandler;
  /** Forwarded to kycWebhookAuth (tests / DI). */
  authOptions?: Parameters<typeof kycWebhookAuth>[0];
}

/**
 * @notice Create the KYC vendor webhook router.
 * @dev Signature verification runs before JSON body handlers see the event.
 */
export function createKycWebhookRouter(options: KycWebhookRouterOptions = {}): Router {
  const handler = options.handler ?? defaultHandler;
  const router = Router();

  router.post(
    '/',
    kycWebhookAuth(options.authOptions),
    async (req: Request, res: Response): Promise<void> => {
      const authReq = req as WebhookAuthenticatedRequest;
      const body = req.body as Partial<KycWebhookEvent>;

      if (!body || typeof body !== 'object' || !body.id || !body.event) {
        res.status(400).json({
          error: 'Invalid KYC webhook payload',
          code: 'INVALID_PAYLOAD',
        });
        return;
      }

      try {
        const result = await handler(
          {
            id: String(body.id),
            event: String(body.event),
            data: body.data,
            timestamp: body.timestamp,
          },
          authReq.webhook?.verifiedByKey ?? 'current'
        );
        res.status(result.success ? 200 : 500).json(result);
      } catch (err) {
        globalLogger.error('KYC webhook handler failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ success: false, message: 'Handler failure' });
      }
    }
  );

  return router;
}
