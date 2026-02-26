import express, { Request, Response, NextFunction } from 'express';

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

// Export handlers separately so tests can call them without spinning up Express
export function createNotificationHandlers(notificationRepo: NotificationRepo) {
  async function getNotifications(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
      const notifications = await notificationRepo.listByUser(user.id);
      return res.json({ notifications });
    } catch (err) {
      return next(err);
    }
  }

  async function markRead(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

      const idParam = req.params.id;
      const body = req.body || {};

      // Bulk via body.ids or if route param = 'bulk' and body.ids provided
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        if (typeof notificationRepo.markReadBulk !== 'function') {
          return res.status(400).json({ error: 'Bulk mark not supported' });
        }
        const count = await notificationRepo.markReadBulk(body.ids, user.id);
        return res.json({ marked: count });
      }

      // Single id
      const idToMark = idParam;
      if (!idToMark) return res.status(400).json({ error: 'Missing id' });
      const ok = await notificationRepo.markRead(idToMark, user.id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      return res.json({ marked: 1 });
    } catch (err) {
      return next(err);
    }
  }

  return { getNotifications, markRead };
}

export default function createNotificationsRouter(opts: {
  notificationRepo: NotificationRepo;
  verifyJWT: express.RequestHandler; // middleware that sets `req.user`
}) {
  const router = express.Router();
  const handlers = createNotificationHandlers(opts.notificationRepo);

  // GET /api/notifications
  router.get('/api/notifications', opts.verifyJWT, handlers.getNotifications);

  // PATCH single or bulk
  router.patch('/api/notifications/:id/read', opts.verifyJWT, handlers.markRead);

  return router;
}
