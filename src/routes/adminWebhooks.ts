import { Router, Request, Response, RequestHandler } from 'express';
import { WebhookEndpointRepository } from '../db/repositories/webhookEndpointRepository';

export function createAdminWebhooksRouter(opts: {
  repo: WebhookEndpointRepository;
  requireAuth: RequestHandler;
}) {
  const { repo, requireAuth } = opts;
  const router = Router();

  // Ensure admin role
  const requireAdmin: RequestHandler = (req, _res, next) => {
    const user = (req as any).user;
    if (!user || user.role !== 'admin') {
      next({ status: 403, message: 'Forbidden: admin role required' });
      return;
    }
    next();
  };

  // List recent dead-letter deliveries for an endpoint
  router.get('/:endpointId/dead-letters', requireAuth, requireAdmin, async (req: Request, res: Response, next) => {
    try {
      const endpointId = req.params.endpointId;
      const limitRaw = parseInt(String(req.query.limit || '50'), 10) || 50;
      const pageRaw = parseInt(String(req.query.page || '0'), 10) || 0;

      const limit = Math.min(Math.max(1, limitRaw), 100); // guard: 1..100
      const offset = Math.max(0, pageRaw) * limit;

      const [items, total] = await Promise.all([
        repo.listDeadLettersByEndpoint(endpointId, limit, offset),
        repo.countDeadLettersByEndpoint(endpointId),
      ]);

      res.json({ total, limit, page: pageRaw, items });
    } catch (err) {
      next(err);
    }
  });

  // Replay a dead-letter delivery idempotently by resetting its status to pending
  router.post('/dead-letters/:id/replay', requireAuth, requireAdmin, async (req: Request, res: Response, next) => {
    try {
      const id = req.params.id;
      const delivery = await repo.findDeliveryById(id);
      if (!delivery) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      if (delivery.status !== 'dead_letter') {
        res.status(400).json({ error: 'Delivery is not dead-lettered' });
        return;
      }

      // Idempotent replay: update existing delivery back to pending and clear errors
      const updated = await repo.updateDelivery(id, {
        status: 'pending',
        attempts: 0,
        last_error: null,
        next_retry_at: null,
      });

      // Trigger immediate re-processing if runtime queue is available
      (async () => {
        try {
          // dynamic import to avoid top-level circular deps
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const idx = require('../index');
          if (idx && idx.WebhookQueue && typeof idx.WebhookQueue.processDelivery === 'function') {
            const endpoint = await repo.findById(delivery.endpoint_id);
            if (endpoint) {
              void idx.WebhookQueue.processDelivery(endpoint.url, delivery.payload, delivery.id);
            }
          }
        } catch (err) {
          // non-fatal: queue may live in a different process
          // eslint-disable-next-line no-console
          console.warn('[adminWebhooks] Could not trigger immediate replay:', err);
        }
      })();

      res.json({ success: true, id: updated.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createAdminWebhooksRouter;
