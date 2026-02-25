import { NextFunction, Response } from 'express';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationPreferencesRouter } from './notificationPreferences';
import {
  NotificationPreferences,
  NotificationPreferencesRepository,
  UpdateNotificationPreferencesInput,
} from '../db/repositories/notificationPreferencesRepository';

class InMemoryNotificationPreferencesRepository implements NotificationPreferencesRepository {
  constructor(private preferences = new Map<string, NotificationPreferences>()) {}

  async getByUserId(userId: string): Promise<NotificationPreferences | null> {
    return this.preferences.get(userId) || null;
  }

  async upsert(userId: string, input: UpdateNotificationPreferencesInput): Promise<NotificationPreferences> {
    const existing = this.preferences.get(userId);
    const updated: NotificationPreferences = {
      user_id: userId,
      email_notifications: input.email_notifications ?? existing?.email_notifications ?? true,
      push_notifications: input.push_notifications ?? existing?.push_notifications ?? true,
      sms_notifications: input.sms_notifications ?? existing?.sms_notifications ?? false,
      updated_at: new Date(),
    };
    this.preferences.set(userId, updated);
    return updated;
  }
}

class MockResponse {
  statusCode = 200;
  payload: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    return this;
  }
}

const createAuthMiddleware = (userId?: string) => {
  return (req: any, _res: Response, next: NextFunction) => {
    if (userId) {
      req.user = { id: userId };
    }
    next();
  };
};

test('GET /api/users/me/notification-preferences returns default preferences when none exist', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  const requireAuth = createAuthMiddleware('user-123');
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = { user: { id: 'user-123' } } as any;
  const res = new MockResponse() as any;

  const handler = router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get)?.route.stack[1].handle;
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    email_notifications: true,
    push_notifications: true,
    sms_notifications: false,
  });
});

test('GET /api/users/me/notification-preferences returns existing preferences', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  await repo.upsert('user-123', { email_notifications: false, push_notifications: true, sms_notifications: true });

  const requireAuth = createAuthMiddleware('user-123');
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = { user: { id: 'user-123' } } as any;
  const res = new MockResponse() as any;

  const handler = router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get)?.route.stack[1].handle;
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.payload as any).email_notifications, false);
  assert.equal((res.payload as any).push_notifications, true);
  assert.equal((res.payload as any).sms_notifications, true);
});

test('PATCH /api/users/me/notification-preferences updates preferences', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  const requireAuth = createAuthMiddleware('user-123');
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = {
    user: { id: 'user-123' },
    body: { email_notifications: false, push_notifications: false },
  } as any;
  const res = new MockResponse() as any;

  const handler = router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.patch)?.route.stack[1].handle;
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal((res.payload as any).email_notifications, false);
  assert.equal((res.payload as any).push_notifications, false);
});

test('GET /api/users/me/notification-preferences returns 401 when not authenticated', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  const requireAuth = createAuthMiddleware();
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = {} as any;
  const res = new MockResponse() as any;

  const handler = router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get)?.route.stack[1].handle;
  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Unauthorized' });
});

test('PATCH /api/users/me/notification-preferences returns 401 when not authenticated', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  const requireAuth = createAuthMiddleware();
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = { body: { email_notifications: false } } as any;
  const res = new MockResponse() as any;

  const handler = router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.patch)?.route.stack[1].handle;
  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Unauthorized' });
});
