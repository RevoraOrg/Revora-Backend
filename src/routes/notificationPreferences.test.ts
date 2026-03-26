import { NextFunction, Response } from 'express';
import { createNotificationPreferencesRouter } from './notificationPreferences';
import {
  NotificationPreferences,
  UpdateNotificationPreferencesInput,
} from '../db/repositories/notificationPreferencesRepository';

class InMemoryNotificationPreferencesRepository {
  constructor(private preferences = new Map<string, NotificationPreferences>()) {}

  async getByUserId(userId: string): Promise<NotificationPreferences | null> {
    return this.preferences.get(userId) ?? null;
  }

  async upsert(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferences> {
    const existing = this.preferences.get(userId);
    const updated: NotificationPreferences = {
      user_id: userId,
      email_notifications:
        input.email_notifications ?? existing?.email_notifications ?? true,
      push_notifications:
        input.push_notifications ?? existing?.push_notifications ?? true,
      sms_notifications:
        input.sms_notifications ?? existing?.sms_notifications ?? false,
      updated_at: new Date(),
    };
    this.preferences.set(userId, updated);
    return updated;
  }
}

function makeReq(user?: { id: string }, body: unknown = {}) {
  return { user, body } as { user?: { id: string }; body: unknown };
}

function makeRes() {
  let statusCode = 200;
  let jsonData: unknown = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: unknown) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; }
  } as unknown as Response & { _get(): { statusCode: number; jsonData: unknown } };
}

const createAuthMiddleware =
  (userId?: string): ((req: any, _res: Response, next: NextFunction) => void) =>
  (req: any, _res: Response, next: NextFunction) => {
    if (userId) {
      req.user = { id: userId };
    }
    next();
  };

function findRouteHandler(router: any, path: string, method: 'get' | 'patch') {
  const layer = router.stack.find(
    (l: any) => l.route?.path === path && l.route?.methods?.[method],
  );
  const routeStack = layer?.route?.stack;
  if (!routeStack) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  }
  // `requireAuth` is stack[0], route handler is stack[1]
  return routeStack[1]?.handle as (req: any, res: any) => Promise<void>;
}

describe('notification preferences routes', () => {
  it('GET /api/users/me/notification-preferences returns defaults when none exist', async () => {
    const repo = new InMemoryNotificationPreferencesRepository();
    const requireAuth = createAuthMiddleware('user-123');
    const router = createNotificationPreferencesRouter({
      requireAuth,
      notificationPreferencesRepository:
        repo as unknown as NotificationPreferencesRepository,
    });

    const req = { user: { id: 'user-123' } } as any;
    const res = new MockResponse() as any;

    const handler = findRouteHandler(
      router,
      '/api/users/me/notification-preferences',
      'get',
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      email_notifications: true,
      push_notifications: true,
      sms_notifications: false,
    });
  });

  it('GET /api/users/me/notification-preferences returns existing preferences', async () => {
    const repo = new InMemoryNotificationPreferencesRepository();
    await repo.upsert('user-123', {
      email_notifications: false,
      push_notifications: true,
      sms_notifications: true,
    });

    const requireAuth = createAuthMiddleware('user-123');
    const router = createNotificationPreferencesRouter({
      requireAuth,
      notificationPreferencesRepository:
        repo as unknown as NotificationPreferencesRepository,
    });

    const req = { user: { id: 'user-123' } } as any;
    const res = new MockResponse() as any;

    const handler = findRouteHandler(
      router,
      '/api/users/me/notification-preferences',
      'get',
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as any).email_notifications).toBe(false);
    expect((res.payload as any).push_notifications).toBe(true);
    expect((res.payload as any).sms_notifications).toBe(true);
  });

  it('PATCH /api/users/me/notification-preferences updates preferences', async () => {
    const repo = new InMemoryNotificationPreferencesRepository();
    const requireAuth = createAuthMiddleware('user-123');
    const router = createNotificationPreferencesRouter({
      requireAuth,
      notificationPreferencesRepository:
        repo as unknown as NotificationPreferencesRepository,
    });

    const req = {
      user: { id: 'user-123' },
      body: { email_notifications: false, push_notifications: false },
    } as any;
    const res = new MockResponse() as any;

    const handler = findRouteHandler(
      router,
      '/api/users/me/notification-preferences',
      'patch',
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as any).email_notifications).toBe(false);
    expect((res.payload as any).push_notifications).toBe(false);
  });

  it('GET /api/users/me/notification-preferences returns 401 when not authenticated', async () => {
    const repo = new InMemoryNotificationPreferencesRepository();
    const requireAuth = createAuthMiddleware();
    const router = createNotificationPreferencesRouter({
      requireAuth,
      notificationPreferencesRepository:
        repo as unknown as NotificationPreferencesRepository,
    });

    const req = {} as any;
    const res = new MockResponse() as any;

    const handler = findRouteHandler(
      router,
      '/api/users/me/notification-preferences',
      'get',
    );
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Unauthorized' });
  });

  it('PATCH /api/users/me/notification-preferences returns 401 when not authenticated', async () => {
    const repo = new InMemoryNotificationPreferencesRepository();
    const requireAuth = createAuthMiddleware();
    const router = createNotificationPreferencesRouter({
      requireAuth,
      notificationPreferencesRepository:
        repo as unknown as NotificationPreferencesRepository,
    });

    const req = { body: { email_notifications: false } } as any;
    const res = new MockResponse() as any;

    const handler = findRouteHandler(
      router,
      '/api/users/me/notification-preferences',
      'patch',
    );
    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Unauthorized' });
  });
});
