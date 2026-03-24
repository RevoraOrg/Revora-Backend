import { NextFunction, Response } from 'express';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationPreferencesRouter } from './notificationPreferences';
import {
  NotificationPreference,
  NotificationPreferencesRepository,
  CreateNotificationPreferenceInput,
  UpdateNotificationPreferenceInput,
  ListNotificationPreferencesOptions,
} from '../db/repositories/notificationPreferencesRepository';

class InMemoryNotificationPreferencesRepository extends NotificationPreferencesRepository {
  private prefs: NotificationPreference[] = [];

  constructor() {
    super({} as any);
  }

  async getPreference(user_id: string, channel: 'email' | 'push', type: string): Promise<NotificationPreference | null> {
    return this.prefs.find(p => p.user_id === user_id && p.channel === channel && p.type === type) || null;
  }

  async listPreferences(options: ListNotificationPreferencesOptions): Promise<NotificationPreference[]> {
    return this.prefs.filter(p => p.user_id === options.user_id && (!options.channel || p.channel === options.channel));
  }

  async createPreference(input: CreateNotificationPreferenceInput): Promise<NotificationPreference> {
    const pref = { ...input, id: 'id', enabled: input.enabled ?? true, created_at: new Date(), updated_at: new Date() } as NotificationPreference;
    this.prefs.push(pref);
    return pref;
  }

  async updatePreference(user_id: string, channel: 'email' | 'push', type: string, input: UpdateNotificationPreferenceInput): Promise<NotificationPreference> {
    const pref = await this.getPreference(user_id, channel, type);
    if (!pref) throw new Error('Not found');
    if (input.enabled !== undefined) pref.enabled = input.enabled;
    return pref;
  }

  async upsertPreference(input: CreateNotificationPreferenceInput & { enabled?: boolean }): Promise<NotificationPreference> {
    const existing = await this.getPreference(input.user_id, input.channel, input.type);
    if (existing) {
      return this.updatePreference(input.user_id, input.channel, input.type, { enabled: input.enabled });
    } else {
      return this.createPreference(input);
    }
  }

  async deletePreference(user_id: string, channel: 'email' | 'push', type: string): Promise<boolean> {
    const initialLen = this.prefs.length;
    this.prefs = this.prefs.filter(p => !(p.user_id === user_id && p.channel === channel && p.type === type));
    return this.prefs.length < initialLen;
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

  const handler = (router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get) as any).route.stack[1].handle;
  await (handler as any)(req, res, () => {});

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    email_notifications: true,
    push_notifications: true,
    sms_notifications: false,
  });
});

test('GET /api/users/me/notification-preferences returns existing preferences', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  await repo.upsertPreference({ user_id: 'user-123', channel: 'email', type: 'global', enabled: false });
  await repo.upsertPreference({ user_id: 'user-123', channel: 'push', type: 'global', enabled: true });

  const requireAuth = createAuthMiddleware('user-123');
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = { user: { id: 'user-123' } } as any;
  const res = new MockResponse() as any;

  const handler = (router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get) as any).route.stack[1].handle;
  await (handler as any)(req, res, () => {});

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

  const handler = (router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.patch) as any).route.stack[1].handle;
  await (handler as any)(req, res, () => {});

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

  const handler = (router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.get) as any).route.stack[1].handle;
  await (handler as any)(req, res, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Unauthorized' });
});

test('PATCH /api/users/me/notification-preferences returns 401 when not authenticated', async () => {
  const repo = new InMemoryNotificationPreferencesRepository();
  const requireAuth = createAuthMiddleware();
  const router = createNotificationPreferencesRouter({ requireAuth, notificationPreferencesRepository: repo });

  const req = { body: { email_notifications: false } } as any;
  const res = new MockResponse() as any;

  const handler = (router.stack.find((layer: any) => layer.route?.path === '/api/users/me/notification-preferences' && layer.route?.methods.patch) as any).route.stack[1].handle;
  await (handler as any)(req, res, () => {});

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.payload, { error: 'Unauthorized' });
});
