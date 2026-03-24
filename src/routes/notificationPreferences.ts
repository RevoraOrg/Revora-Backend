import { RequestHandler, Router } from 'express';
import { NotificationPreferencesRepository } from '../db/repositories/notificationPreferencesRepository';

interface AuthenticatedRequest {
  user?: { id: string };
}

interface CreateNotificationPreferencesRouterDeps {
  requireAuth: RequestHandler;
  notificationPreferencesRepository: NotificationPreferencesRepository;
}

export const createNotificationPreferencesRouter = ({
  requireAuth,
  notificationPreferencesRepository,
}: CreateNotificationPreferencesRouterDeps): Router => {
  const router = Router();

  router.get('/api/users/me/notification-preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const prefs = await notificationPreferencesRepository.listPreferences({ user_id: userId });
      
      return res.json({
        email_notifications: prefs.find(p => p.channel === 'email')?.enabled ?? true,
        push_notifications: prefs.find(p => p.channel === 'push')?.enabled ?? true,
        sms_notifications: false,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch notification preferences' });
    }
  });

  router.patch('/api/users/me/notification-preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email_notifications, push_notifications } = req.body;

    try {
      if (email_notifications !== undefined) {
         await notificationPreferencesRepository.upsertPreference({ user_id: userId, channel: 'email', type: 'global', enabled: email_notifications });
      }
      if (push_notifications !== undefined) {
         await notificationPreferencesRepository.upsertPreference({ user_id: userId, channel: 'push', type: 'global', enabled: push_notifications });
      }
      
      const prefs = await notificationPreferencesRepository.listPreferences({ user_id: userId });
      res.json({
        email_notifications: prefs.find(p => p.channel === 'email')?.enabled ?? true,
        push_notifications: prefs.find(p => p.channel === 'push')?.enabled ?? true,
        sms_notifications: false,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to update notification preferences' });
    }
  });

  return router;
};
