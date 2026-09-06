/**
 * KYC/AML Provider Webhook Receiver
 *
 * Receives signed provider status callbacks and applies them through the
 * {@link KycVerificationService}. Security contract:
 *
 *  - **Signature verification**: the request body is read raw and verified via
 *    `kycWebhookAuth` (HMAC-SHA256, dual-key rotation, constant-time compare).
 *  - **Replay protection**: a required `x-webhook-timestamp` header bounds the
 *    callback age (`maxAgeMs`), and the verification service rejects duplicate
 *    provider transaction ids via the replay guard.
 *  - **Replayable audit trail**: every accepted callback is written to the
 *    audit log keyed by `provider_tx_id`.
 *
 * Mount this router BEFORE the application-level JSON body parser so the raw
 * bytes are available for signature verification (byte-exact, not re-serialized).
 */

import { Router, Request, Response, raw } from 'express';
import { kycWebhookAuth, WebhookAuthenticatedRequest } from '../middleware/webhookAuth';
import { KycVerificationService } from '../services/kyc/kycVerificationService';
import { globalLogger } from '../lib/logger';

export interface CreateKycWebhooksRouterDeps {
  verificationService: KycVerificationService;
  requireTimestamp?: boolean;
  maxAgeMs?: number;
  maxPayloadSize?: number;
}

export function createKycWebhooksRouter(deps: CreateKycWebhooksRouterDeps): Router {
  const {
    verificationService,
    requireTimestamp = true,
    maxAgeMs = 5 * 60 * 1000,
    maxPayloadSize = 1024 * 1024,
  } = deps;

  const router = Router();

  router.post(
    '/',
    raw({ type: 'application/json', limit: `${maxPayloadSize}b` }),
    kycWebhookAuth({ requireTimestamp, maxAgeMs, maxPayloadSize }),
    async (req: Request, res: Response): Promise<void> => {
      const authReq = req as WebhookAuthenticatedRequest;

      // Raw body → JSON object for the verification service.
      let body: unknown;
      try {
        const payload = req.body as Buffer;
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        res.status(400).json({
          success: false,
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
        });
        return;
      }

      try {
        const outcome = await verificationService.recordVerifiedCallback(body, {
          verifiedByKey: authReq.webhook?.verifiedByKey,
        });

        switch (outcome.outcome) {
          case 'accepted':
            res.status(200).json({
              success: true,
              outcome: 'accepted',
              providerTxId: outcome.providerTxId,
              status: outcome.status,
            });
            return;
          case 'duplicate':
            // Idempotent ack: the event was already processed; the provider
            // should stop retrying without us re-mutating state.
            res.status(200).json({
              success: true,
              outcome: 'duplicate',
              providerTxId: outcome.providerTxId,
              status: outcome.status,
            });
            return;
          case 'rejected':
            res.status(400).json({
              success: false,
              outcome: 'rejected',
              message: 'Callback rejected: malformed or unsupported payload',
            });
            return;
          default:
            // user_not_found / user_missing: event audited; nothing to mutate.
            res.status(200).json({
              success: true,
              outcome: outcome.outcome,
              providerTxId: outcome.providerTxId,
              status: outcome.status,
            });
            return;
        }
      } catch (err) {
        globalLogger.error('KYC webhook processing failed', { error: err });
        res.status(500).json({
          success: false,
          message: 'Callback processing failed',
        });
      }
    },
  );

  return router;
}