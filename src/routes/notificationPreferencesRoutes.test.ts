/**
 * @fileoverview Test suite for src/routes/notificationPreferencesRoutes.ts
 *
 * Covers createNotificationPreferencesRouter:
 *   GET    /:userId/notifications  – export preferences
 *   PUT    /:userId/notifications  – update preferences
 *   DELETE /:userId/notifications  – delete preferences
 *
 * Strategy
 * ---------
 * • authMiddleware and ensureUserOwnsResource are mocked at the module level so
 *   auth-bypass and auth-enforcement cases can be exercised in isolation.
 * • NotificationPreferencesService is mocked via jest.fn() so every branch
 *   (success, NotFoundError, BadRequestError, unexpected Error) is deterministic.
 * • supertest drives the full Express middleware stack so route wiring, error
 *   propagation through next(), and the global error handler are all exercised.
 */

import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';

// ── Module-level mocks (must be before any import that uses the real modules) ──

jest.mock('../middleware/auth', () => ({
  authMiddleware: jest.fn(),
  ensureUserOwnsResource: jest.fn(),
}));

// ── Imports that must come after jest.mock declarations ─────────────────────

import { authMiddleware, ensureUserOwnsResource } from '../middleware/auth';
import { createNotificationPreferencesRouter } from './notificationPreferencesRoutes';
import { NotificationPreferencesService } from '../services/notificationPreferencesService';
import {
  NotFoundError,
  BadRequestError,
  AppError,
  ErrorCode,
} from '../lib/errors';
import { Logger } from '../lib/logger';
import {
  NotificationPreferences,
  InMemoryNotificationPreferencesRepository,
} from '../lib/notificationPreferencesRepository';

// ── Typed mock helpers ───────────────────────────────────────────────────────

const mockAuthMiddleware = authMiddleware as jest.Mock;
const mockEnsureUserOwnsResource = ensureUserOwnsResource as jest.Mock;

// ── Constants ────────────────────────────────────────────────────────────────

const USER_ID = 'user-abc-123';
const OTHER_USER_ID = 'user-xyz-999';

const SAMPLE_PREFS: NotificationPreferences = {
  id: 'pref-001',
  userId: USER_ID,
  emailNotifications: true,
  smsNotifications: false,
  emailAddress: 'alice@example.com',
  phoneNumber: undefined,
  preferredLanguage: 'en',
  quietHours: undefined,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

// ── Test-app factory ─────────────────────────────────────────────────────────

/**
 * Creates an Express app that:
 * 1. Mounts the notification preferences router under `/users`.
 * 2. Registers a minimal JSON error handler so AppError status codes are
 *    returned as structured JSON rather than Express's default HTML.
 */
function buildApp(
  service: Partial<NotificationPreferencesService>,
): express.Express {
  const app = express();
  app.use(express.json());

  const logger = new Logger();
  const router = createNotificationPreferencesRouter({
    notificationPreferencesService: service as NotificationPreferencesService,
    logger,
  });

  app.use('/users', router);

  // Minimal error handler – mirrors the shape used in the real app.
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({
          code: err.code,
          message: err.message,
        });
        return;
      }
      res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    },
  );

  return app;
}

// ── Per-suite middleware configuration ───────────────────────────────────────

/**
 * Configure the auth mocks so that they behave as pass-through middleware,
 * optionally injecting `req.user`.
 */
function allowAuth(userId: string): void {
  mockAuthMiddleware.mockImplementation(
    () => (req: any, _res: Response, next: NextFunction) => {
      req.user = { id: userId, role: 'investor' };
      next();
    },
  );
  mockEnsureUserOwnsResource.mockImplementation(
    (req: any, _res: Response, next: NextFunction) => {
      next();
    },
  );
}

/**
 * Configure authMiddleware to reject with a 401.
 */
function denyAuth(): void {
  mockAuthMiddleware.mockImplementation(
    () => (_req: Request, _res: Response, next: NextFunction) => {
      next(new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authorization header missing'));
    },
  );
  mockEnsureUserOwnsResource.mockImplementation(
    (_req: Request, _res: Response, next: NextFunction) => next(),
  );
}

/**
 * Configure ensureUserOwnsResource to reject with a 403.
 */
function denyOwnership(): void {
  mockAuthMiddleware.mockImplementation(
    () => (req: any, _res: Response, next: NextFunction) => {
      req.user = { id: OTHER_USER_ID, role: 'investor' };
      next();
    },
  );
  mockEnsureUserOwnsResource.mockImplementation(
    (_req: Request, _res: Response, next: NextFunction) => {
      next(new AppError(ErrorCode.FORBIDDEN, 403, 'Forbidden: you do not own this resource'));
    },
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeService(
  overrides: Partial<Record<keyof NotificationPreferencesService, jest.Mock>>,
): Partial<NotificationPreferencesService> {
  return {
    getPreferences: jest.fn(),
    updatePreferences: jest.fn(),
    deletePreferences: jest.fn(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test suites
// ═══════════════════════════════════════════════════════════════════════════════

describe('createNotificationPreferencesRouter', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Route wiring ────────────────────────────────────────────────────────────

  describe('route wiring', () => {
    it('registers GET, PUT, and DELETE handlers under /:userId/notifications', () => {
      const service = makeService({});
      const logger = new Logger();
      const router = createNotificationPreferencesRouter({
        notificationPreferencesService: service as NotificationPreferencesService,
        logger,
      });

      const routes: Array<{ path: string; methods: Record<string, boolean> }> =
        (router as any).stack
          .filter((layer: any) => layer.route)
          .map((layer: any) => ({
            path: layer.route.path,
            methods: layer.route.methods,
          }));

      expect(routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/:userId/notifications', methods: expect.objectContaining({ get: true }) }),
          expect.objectContaining({ path: '/:userId/notifications', methods: expect.objectContaining({ put: true }) }),
          expect.objectContaining({ path: '/:userId/notifications', methods: expect.objectContaining({ delete: true }) }),
        ]),
      );
    });
  });

  // ── GET /:userId/notifications ──────────────────────────────────────────────

  describe('GET /:userId/notifications', () => {

    it('200 – returns preferences for the authenticated owner', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        getPreferences: jest.fn().mockResolvedValue(SAMPLE_PREFS),
      });
      const app = buildApp(service);

      const res = await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(200);

      expect(res.body).toMatchObject({
        userId: USER_ID,
        emailNotifications: true,
        smsNotifications: false,
      });
      expect(service.getPreferences).toHaveBeenCalledWith(USER_ID);
    });

    it('404 – service throws NotFoundError when prefs are absent', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        getPreferences: jest
          .fn()
          .mockRejectedValue(
            new NotFoundError(`Notification preferences not found for user ${USER_ID}`),
          ),
      });
      const app = buildApp(service);

      const res = await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(404);

      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
      expect(res.body.message).toMatch(USER_ID);
    });

    it('401 – rejects unauthenticated requests', async () => {
      denyAuth();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(401);

      expect(service.getPreferences).not.toHaveBeenCalled();
    });

    it("403 – rejects a user attempting to read another user's preferences", async () => {
      denyOwnership();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(403);

      expect(service.getPreferences).not.toHaveBeenCalled();
    });

    it('500 – propagates unexpected service errors', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        getPreferences: jest
          .fn()
          .mockRejectedValue(new Error('Unexpected DB failure')),
      });
      const app = buildApp(service);

      await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(500);
    });
  });

  // ── PUT /:userId/notifications ──────────────────────────────────────────────

  describe('PUT /:userId/notifications', () => {

    it('200 – updates and returns preferences for valid input', async () => {
      allowAuth(USER_ID);
      const updated: NotificationPreferences = {
        ...SAMPLE_PREFS,
        emailNotifications: false,
        updatedAt: new Date(),
      };
      const service = makeService({
        updatePreferences: jest.fn().mockResolvedValue(updated),
      });
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: false })
        .expect(200);

      expect(res.body.emailNotifications).toBe(false);
      expect(service.updatePreferences).toHaveBeenCalledWith(USER_ID, {
        emailNotifications: false,
      });
    });

    it('200 – updates multiple preference fields at once', async () => {
      allowAuth(USER_ID);
      const input = {
        emailNotifications: true,
        smsNotifications: true,
        preferredLanguage: 'fr',
      };
      const updated = { ...SAMPLE_PREFS, ...input };
      const service = makeService({
        updatePreferences: jest.fn().mockResolvedValue(updated),
      });
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send(input)
        .expect(200);

      expect(res.body.preferredLanguage).toBe('fr');
      expect(res.body.smsNotifications).toBe(true);
    });

    it('400 – rejects an empty request body', async () => {
      allowAuth(USER_ID);
      const service = makeService({});
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({})
        .expect(400);

      expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(res.body.message).toMatch(/cannot be empty/i);
      expect(service.updatePreferences).not.toHaveBeenCalled();
    });

    it('400 – service validation rejects a malformed email address', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        updatePreferences: jest
          .fn()
          .mockRejectedValue(new BadRequestError('Invalid email address format')),
      });
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailAddress: 'not-an-email' })
        .expect(400);

      expect(res.body.code).toBe(ErrorCode.BAD_REQUEST);
      expect(res.body.message).toMatch(/email/i);
    });

    it('400 – service validation rejects invalid quietHours config', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        updatePreferences: jest
          .fn()
          .mockRejectedValue(
            new BadRequestError('quietHours.startHour must be an integer between 0 and 23'),
          ),
      });
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({
          quietHours: { enabled: true, startHour: 99, endHour: 8, timezone: 'UTC' },
        })
        .expect(400);

      expect(res.body.message).toMatch(/startHour/i);
    });

    it('404 – service throws NotFoundError for unknown userId', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        updatePreferences: jest
          .fn()
          .mockRejectedValue(
            new NotFoundError(`Notification preferences not found for user ${USER_ID}`),
          ),
      });
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: true })
        .expect(404);

      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('401 – rejects unauthenticated requests', async () => {
      denyAuth();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: true })
        .expect(401);

      expect(service.updatePreferences).not.toHaveBeenCalled();
    });

    it("403 – rejects a user attempting to modify another user's preferences", async () => {
      denyOwnership();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: true })
        .expect(403);

      expect(service.updatePreferences).not.toHaveBeenCalled();
    });

    it('500 – propagates unexpected service errors', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        updatePreferences: jest
          .fn()
          .mockRejectedValue(new Error('Disk full')),
      });
      const app = buildApp(service);

      await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: false })
        .expect(500);
    });
  });

  // ── DELETE /:userId/notifications ───────────────────────────────────────────

  describe('DELETE /:userId/notifications', () => {

    it('204 – deletes preferences and returns no content', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        deletePreferences: jest.fn().mockResolvedValue(undefined),
      });
      const app = buildApp(service);

      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(204);

      expect(service.deletePreferences).toHaveBeenCalledWith(USER_ID);
    });

    it('204 – response body is empty', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        deletePreferences: jest.fn().mockResolvedValue(undefined),
      });
      const app = buildApp(service);

      const res = await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(204);

      expect(res.text).toBe('');
    });

    it('404 – service throws NotFoundError when preferences do not exist', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        deletePreferences: jest
          .fn()
          .mockRejectedValue(
            new NotFoundError(`Notification preferences not found for user ${USER_ID}`),
          ),
      });
      const app = buildApp(service);

      const res = await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(404);

      expect(res.body.code).toBe(ErrorCode.NOT_FOUND);
      expect(res.body.message).toMatch(USER_ID);
    });

    it('401 – rejects unauthenticated requests', async () => {
      denyAuth();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(401);

      expect(service.deletePreferences).not.toHaveBeenCalled();
    });

    it("403 – rejects a user attempting to delete another user's preferences", async () => {
      denyOwnership();
      const service = makeService({});
      const app = buildApp(service);

      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(403);

      expect(service.deletePreferences).not.toHaveBeenCalled();
    });

    it('500 – propagates unexpected service errors', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        deletePreferences: jest
          .fn()
          .mockRejectedValue(new Error('Connection lost')),
      });
      const app = buildApp(service);

      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(500);
    });
  });

  // ── Auth middleware wiring ───────────────────────────────────────────────────

  describe('auth middleware wiring', () => {
    it('calls authMiddleware() as a factory (invoked, not applied directly)', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        getPreferences: jest.fn().mockResolvedValue(SAMPLE_PREFS),
      });
      buildApp(service);

      // authMiddleware should have been called as a factory when the router was built.
      expect(mockAuthMiddleware).toHaveBeenCalled();
    });

    it('applies ensureUserOwnsResource on each route', async () => {
      allowAuth(USER_ID);
      const service = makeService({
        getPreferences: jest.fn().mockResolvedValue(SAMPLE_PREFS),
        updatePreferences: jest.fn().mockResolvedValue(SAMPLE_PREFS),
        deletePreferences: jest.fn().mockResolvedValue(undefined),
      });
      const app = buildApp(service);

      await request(app).get(`/users/${USER_ID}/notifications`);
      await request(app).put(`/users/${USER_ID}/notifications`).send({ emailNotifications: true });
      await request(app).delete(`/users/${USER_ID}/notifications`);

      // Each route should pass through ensureUserOwnsResource (once per request).
      expect(mockEnsureUserOwnsResource).toHaveBeenCalledTimes(3);
    });
  });

  // ── Integration with real service and repository ────────────────────────────

  describe('integration: real service + in-memory repository', () => {
    let repo: InMemoryNotificationPreferencesRepository;
    let service: NotificationPreferencesService;

    beforeEach(async () => {
      const { InMemoryNotificationPreferencesRepository } =
        await import('../lib/notificationPreferencesRepository');
      const { NotificationPreferencesService } =
        await import('../services/notificationPreferencesService');

      repo = new InMemoryNotificationPreferencesRepository();
      service = new NotificationPreferencesService(repo);
    });

    it('round-trips: create → read → delete', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      // Create via PUT
      await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: true, preferredLanguage: 'de' })
        .expect(200);

      // Read back
      const getRes = await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(200);
      expect(getRes.body.preferredLanguage).toBe('de');

      // Delete
      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(204);

      // Should now be 404
      await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(404);
    });

    it('PUT updates an existing preference record', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: true })
        .expect(200);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailNotifications: false })
        .expect(200);

      expect(res.body.emailNotifications).toBe(false);
    });

    it('GET returns 404 when no preferences exist yet', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      await request(app)
        .get(`/users/${USER_ID}/notifications`)
        .expect(404);
    });

    it('DELETE returns 404 when no preferences exist', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      await request(app)
        .delete(`/users/${USER_ID}/notifications`)
        .expect(404);
    });

    it('PUT rejects an invalid email address', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ emailAddress: 'not-a-valid-email' })
        .expect(400);

      expect(res.body.message).toMatch(/email/i);
    });

    it('PUT accepts a valid quietHours configuration', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      const quietHours = {
        enabled: true,
        startHour: 22,
        endHour: 8,
        timezone: 'America/New_York',
      };

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({ quietHours })
        .expect(200);

      expect(res.body.quietHours).toMatchObject(quietHours);
    });

    it('PUT rejects invalid IANA timezone in quietHours', async () => {
      allowAuth(USER_ID);
      const app = buildApp(service);

      const res = await request(app)
        .put(`/users/${USER_ID}/notifications`)
        .send({
          quietHours: {
            enabled: true,
            startHour: 22,
            endHour: 8,
            timezone: 'Not/A_Timezone',
          },
        })
        .expect(400);

      expect(res.body.message).toMatch(/timezone/i);
    });
  });
});
