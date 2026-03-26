import { Request, RequestHandler, Response, Router } from 'express';
import {
  NotificationPreferencesRepository,
  UpdateNotificationPreferencesInput,
} from '../db/repositories/notificationPreferencesRepository';

/** JWT-authenticated request with user context injected by auth middleware. */
interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

/** Valid notification channel field names. */
type NotificationField = 'email_notifications' | 'push_notifications' | 'sms_notifications';

/**
 * Validate the PATCH request body for notification preferences.
 * Ensures all provided fields are boolean and rejects unknown fields.
 * @param body Raw request body
 * @returns Array of validation error messages; empty if valid
 */
export function validateNotificationPreferencesInput(
  body: unknown
): string[] {
  const errors: string[] = [];

  if (body === null || body === undefined) {
    return ['body must be a non-null object'];
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    return ['body must be a non-null object'];
  }

  const record = body as Record<string, unknown>;
  const allowedFields: NotificationField[] = [
    'email_notifications',
    'push_notifications',
    'sms_notifications',
  ];

  for (const [key, value] of Object.entries(record)) {
    if (!allowedFields.includes(key as NotificationField)) {
      errors.push(`Unknown field: ${key}`);
      continue;
    }

    if (value !== undefined && typeof value !== 'boolean') {
      errors.push(`${key} must be a boolean`);
    }
  }

  return errors;
}

  const toWireShape = (prefs: {
    email_notifications: boolean;
    push_notifications: boolean;
    sms_notifications: boolean;
  }) => ({
    email_notifications: prefs.email_notifications,
    push_notifications: prefs.push_notifications,
    sms_notifications: prefs.sms_notifications,
  });

  router.get('/api/users/me/notification-preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const preferences = await notificationRepo.getByUserId(userId);
      if (!preferences) {
        res.json({
          email_notifications: true,
          push_notifications:  true,
          sms_notifications:   false,
        });
        return;
      }
      res.json(toWireShape(preferences));
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch notification preferences' });
    }
  }

  /**
   * PATCH /api/users/me/notification-preferences
   * Partially updates the authenticated user's notification preferences.
   * Only boolean fields are accepted; unknown fields are rejected.
   */
  async function updatePreferences(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const errors = validateNotificationPreferencesInput(req.body);
    if (errors.length > 0) {
      res.status(400).json({
        error: 'ValidationError',
        details: errors,
      });
      return;
    }

    const input: UpdateNotificationPreferencesInput = {
      email_notifications:  req.body.email_notifications,
      push_notifications:   req.body.push_notifications,
      sms_notifications:    req.body.sms_notifications,
    };

    try {
      const updated = await notificationPreferencesRepository.upsert(userId, {
        email_notifications,
        push_notifications,
        sms_notifications,
      });
      res.json(toWireShape(updated));
    } catch (error) {
      res.status(500).json({ error: 'Failed to update notification preferences' });
    }
  }

  return { getPreferences, updatePreferences };
}

/** Dependency injection bag for the router factory. */
interface CreateNotificationPreferencesRouterDeps {
  requireAuth: RequestHandler;
  notificationPreferencesRepository: NotificationPreferencesRepository;
}

/**
 * Create Express router for user notification preferences endpoints.
 * Provides GET (fetch) and PATCH (update) operations scoped to the
 * authenticated user only.
 *
 * Security assumptions:
 * - User can only modify their own preferences (enforced via requireAuth + userId scoping)
 * - Input is validated to prevent type confusion attacks
 * - Database operations are parameterized to prevent SQL injection
 */
export const createNotificationPreferencesRouter = ({
  requireAuth,
  notificationPreferencesRepository,
}: CreateNotificationPreferencesRouterDeps): Router => {
  const router = Router();
  const handlers = createNotificationPreferencesHandlers(notificationPreferencesRepository);

  router.get('/api/users/me/notification-preferences', requireAuth, handlers.getPreferences);
  router.patch('/api/users/me/notification-preferences', requireAuth, handlers.updatePreferences);

  return router;
};
