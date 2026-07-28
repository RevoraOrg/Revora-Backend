import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { createRateLimitMiddleware } from '../middleware/rateLimit';

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  message: string;
  read: boolean;
  created_at: Date;
}

export interface NotificationRepo {
  listByUser: (userId: string) => Promise<Notification[]>;
  markRead: (id: string, userId: string) => Promise<boolean>;
  markReadBulk?: (ids: string[], userId: string) => Promise<number>;
}

// Schemas
const markReadBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).optional(),
});

const markReadParamsSchema = z.object({
  id: z.string().uuid().or(z.literal('bulk')),
});

export function createNotificationHandlers(notificationRepo: NotificationRepo) {
  const logger = globalLogger.child({ component: 'NotificationHandlers' });

  async function getNotifications(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return next(Errors.unauthorized());
      }

      logger.info('Fetching notifications for user', { userId: user.id });
      const notifications = await notificationRepo.listByUser(user.id);
      
      return res.json({ notifications });
    } catch (err) {
      logger.error('Failed to fetch notifications', { error: err });
      return next(err);
    }
  }

  async function markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        return next(Errors.unauthorized());
      }

      const params = markReadParamsSchema.safeParse(req.params);
      if (!params.success) {
        return next(Errors.validationError('Invalid notification ID', params.error.format()));
      }

      const body = markReadBodySchema.safeParse(req.body);
      if (!body.success) {
        return next(Errors.validationError('Invalid request body', body.error.format()));
      }

      const idParam = params.data.id;
      const idsFromBody = body.data.ids;

      // Bulk handling
      if (idParam === 'bulk' || (idsFromBody && idsFromBody.length > 0)) {
        if (!idsFromBody || idsFromBody.length === 0) {
          return next(Errors.badRequest('Bulk operation requires "ids" array in body'));
        }

        if (typeof notificationRepo.markReadBulk !== 'function') {
          return next(Errors.badRequest('Bulk mark not supported'));
        }

        logger.info('Marking notifications as read (bulk)', { userId: user.id, count: idsFromBody.length });
        const count = await notificationRepo.markReadBulk(idsFromBody, user.id);
        return res.json({ marked: count });
      }

      // Single ID handling
      logger.info('Marking notification as read', { userId: user.id, notificationId: idParam });
      const ok = await notificationRepo.markRead(idParam, user.id);
      if (!ok) {
        return next(Errors.notFound('Notification not found'));
      }
      
      return res.json({ marked: 1 });
    } catch (err) {
      logger.error('Failed to mark notification as read', { error: err });
      return next(err);
    }
  }

  return { getNotifications, markRead };
}

export default function createNotificationsRouter(opts: {
  notificationRepo: NotificationRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createNotificationHandlers(opts.notificationRepo);

  // Rate limiting: 100 requests per minute per user for notification routes
  const limiter = createRateLimitMiddleware({
    limit: 100,
    windowMs: 60_000,
    perUser: true,
    keyPrefix: 'notifications',
  });

  // Apply rate limiter and JWT verification to all routes
  router.use(opts.verifyJWT, limiter);

  // GET /notifications
  router.get('/notifications', handlers.getNotifications);

  // PATCH single or bulk
  // Example: PATCH /notifications/id/read OR PATCH /notifications/bulk/read with { "ids": [...] }
  router.patch('/notifications/:id/read', handlers.markRead);

  return router;
}
