import { Router, Request, Response, NextFunction } from 'express';
import { WebhookEndpointRepository } from '../db/repositories/webhookEndpointRepository';
import { WebhookQueue } from '../index';
import { Errors } from '../lib/errors';
import { requireAdmin, AuthenticatedRequest } from '../middleware/auth';

interface AdminWebhookRouterDependencies {
  webhookEndpointRepo: WebhookEndpointRepository;
}

export function createAdminWebhookRouter(deps: AdminWebhookRouterDependencies): Router {
  const { webhookEndpointRepo } = deps;
  const router = Router();

  // Apply admin auth to all routes in this router
  router.use(requireAdmin);

  // List recent dead-letter deliveries for an endpoint
  router.get('/:endpointId/dead-letters', async (req: Request, res: Response, next) => {
    try {
      const endpointId = req.params.endpointId;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
      const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

      const endpoint = await webhookEndpointRepo.findById(endpointId);
      if (!endpoint) {
        return next(Errors.notFound('Webhook endpoint not found'));
      }

      const deadLetters = await webhookEndpointRepo.listDeadLettersByEndpoint(endpointId, limit, offset);
      const total = await webhookEndpointRepo.countDeadLettersByEndpoint(endpointId);

      res.status(200).json({
        endpointId,
        deadLetters,
        pagination: { limit, offset, total },
      });
    } catch (error) {
      next(error);
    }
  });

  // Replay a dead-letter delivery idempotently by resetting its status to pending
  router.post('/dead-letters/:id/replay', async (req: Request, res: Response, next) => {
    try {
      const id = req.params.id;
      const delivery = await webhookEndpointRepo.findDeliveryById(id);

      if (!delivery) {
        return next(Errors.notFound('Delivery not found'));
      }

      if (delivery.status !== 'dead_letter') {
        return next(Errors.badRequest('Only dead-letter deliveries can be replayed'));
      }

      const endpoint = await webhookEndpointRepo.findById(delivery.endpoint_id);
      if (!endpoint) {
        return next(Errors.notFound('Associated webhook endpoint not found'));
      }

      // Check for existing delivery with same event_id to ensure idempotency
      const eventId = (delivery.payload as any)?.id;
      if (eventId) {
        // Simple idempotency: check if a completed delivery with the same event_id exists
        // In production, you might want a more robust approach with a dedicated idempotency table
        const existingCompleted = await webhookEndpointRepo.findCompletedDeliveryByEventId(delivery.endpoint_id, eventId);
        if (existingCompleted) {
          return res.status(200).json({
            message: 'Delivery already completed for this event_id',
            deliveryId: existingCompleted.id,
            status: 'already_completed',
          });
        }
      }

      // Reset to pending and re-enqueue
      await webhookEndpointRepo.updateDelivery(id, {
        status: 'pending',
        attempts: 0,
        last_error: null,
        next_retry_at: null,
      });

      // Re-enqueue via WebhookQueue
      void WebhookQueue.processDelivery(endpoint.url, delivery.payload, id);

      res.status(200).json({
        message: 'Dead-letter delivery replayed successfully',
        deliveryId: id,
        status: 'replayed',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
