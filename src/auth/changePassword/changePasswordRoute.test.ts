/**
 * Route-level behavior suite for `createChangePasswordRouter`
 * (`src/auth/changePassword/changePasswordRoute.ts`, Issue #963).
 *
 * The factory wires UserRepository + SessionRepository onto the supplied pg
 * pool, builds a real ChangePasswordService (scrypt hashing, strength
 * validation, transactional session invalidation), and exposes two routes:
 *   POST  /me/change-password
 *   PATCH /me/password   (alias)
 *
 * Only the data layer is doubled. The handler, service, password utils, and
 * password-strength policy all run for real so the documented success and
 * failure contracts are exercised end to end through supertest.
 *
 * Auth is provided by the injected `requireAuth` middleware (mirrors
 * createRequireAuth in production). A rejecting stub covers the 401 path.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';

/* ─── data-layer doubles ──────────────────────────────────────────────────── */

jest.mock('../../db/repositories/userRepository', () => {
  const state = {
    instances: [] as unknown[],
    poolArgs: [] as unknown[],
    findById: jest.fn(),
    updatePasswordHash: jest.fn(),
  };
  class UserRepository {
    findById = state.findById;
    updatePasswordHash = state.updatePasswordHash;
    constructor(pool: unknown) {
      state.instances.push(this);
      state.poolArgs.push(pool);
    }
  }
  return { UserRepository, __state: state };
});

jest.mock('../../db/repositories/sessionRepository', () => {
  const state = {
    instances: [] as unknown[],
    poolArgs: [] as unknown[],
    deleteAllSessionsByUserId: jest.fn(),
  };
  class SessionRepository {
    deleteAllSessionsByUserId = state.deleteAllSessionsByUserId;
    constructor(pool: unknown) {
      state.instances.push(this);
      state.poolArgs.push(pool);
    }
  }
  return { SessionRepository, __state: state };
});

// Silence route/service logger noise during tests. `globalLogger.child` is
// required by src/db/transaction.ts (withTransaction used by the service).
jest.mock('../../lib/logger', () => {
  const makeLogger = () => {
    const log = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      critical: jest.fn(),
    };
    return { ...log, child: jest.fn().mockImplementation(() => makeLogger()) };
  };
  return {
    Logger: jest.fn().mockImplementation(() => makeLogger()),
    globalLogger: makeLogger(),
  };
});

/* ─── imports (mocks are hoisted above these) ────────────────────────────── */

import { createChangePasswordRouter } from './changePasswordRoute';
import { errorHandler } from '../../middleware/errorHandler';
import { Errors } from '../../lib/errors';
import { hashPassword } from '../../utils/password';
import * as userRepoModule from '../../db/repositories/userRepository';
import * as sessionRepoModule from '../../db/repositories/sessionRepository';

const userState = (userRepoModule as unknown as {
  __state: {
    instances: unknown[];
    poolArgs: unknown[];
    findById: jest.Mock;
    updatePasswordHash: jest.Mock;
  };
}).__state;

const sessionState = (sessionRepoModule as unknown as {
  __state: {
    instances: unknown[];
    poolArgs: unknown[];
    deleteAllSessionsByUserId: jest.Mock;
  };
}).__state;

/* ─── helpers ────────────────────────────────────────────────────────────── */

/** Request shape populated by createRequireAuth (see src/middleware/auth.ts). */
type AuthenticatedReq = Request & {
  user?: { sub?: string; id?: string; role?: string };
  auth?: { userId: string; sessionId: string; tokenId?: string };
};

const CURRENT_PASSWORD = 'CurrentPass159!';
const NEW_PASSWORD = 'NewSecurePw481!';
const WEAK_PASSWORD = 'short';
const USER_ID = 'user-1';

/** Minimal fake pg pool: withTransaction only needs connect() + client.query(). */
function makeMockPool(): Pool {
  const client: Partial<PoolClient> = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
  } as unknown as Pool;
}

/** Authenticated stub — mirrors createRequireAuth's req.user shape. */
function createAuthenticatedRequireAuth(userId: string = USER_ID) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedReq;
    authReq.user = { sub: userId, id: userId, role: 'startup' };
    authReq.auth = { userId, sessionId: 'session-1', tokenId: 'token-1' };
    next();
  };
}

/** Rejecting stub — mirrors createRequireAuth's 401 path for bad/missing tokens. */
function createRejectingRequireAuth(message = 'Unauthorized: Missing or invalid Authorization header') {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(Errors.unauthorized(message));
  };
}

function makeApp(requireAuth = createAuthenticatedRequireAuth()) {
  const router = createChangePasswordRouter({ db: makeMockPool(), requireAuth });
  const app = express();
  app.use(express.json());
  // Mirror src/app.ts: router is mounted at the application root (no prefix).
  app.use(router);
  app.use(errorHandler);
  return app;
}

async function seedUserWithPassword(plainPassword: string, userId: string = USER_ID) {
  const password_hash = await hashPassword(plainPassword);
  userState.findById.mockResolvedValue({ id: userId, password_hash });
  userState.updatePasswordHash.mockResolvedValue(undefined);
  sessionState.deleteAllSessionsByUserId.mockResolvedValue(undefined);
  return password_hash;
}

beforeEach(() => {
  jest.clearAllMocks();
  userState.instances.length = 0;
  userState.poolArgs.length = 0;
  sessionState.instances.length = 0;
  sessionState.poolArgs.length = 0;
  userState.findById.mockReset();
  userState.updatePasswordHash.mockReset();
  sessionState.deleteAllSessionsByUserId.mockReset();
});

/* ─── factory wiring ─────────────────────────────────────────────────────── */

describe('createChangePasswordRouter wiring', () => {
  it('constructs both repositories with the supplied pool', () => {
    const pool = makeMockPool();
    createChangePasswordRouter({ db: pool, requireAuth: createAuthenticatedRequireAuth() });

    expect(userState.poolArgs).toEqual([pool]);
    expect(sessionState.poolArgs).toEqual([pool]);
  });

  it('registers POST /me/change-password and PATCH /me/password', () => {
    const router = createChangePasswordRouter({
      db: makeMockPool(),
      requireAuth: createAuthenticatedRequireAuth(),
    });
    const layers = (router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;

    const routes = layers
      .filter((layer) => layer.route)
      .map((layer) => ({
        method: Object.keys(layer.route!.methods)[0].toUpperCase(),
        path: layer.route!.path,
      }));

    expect(routes).toEqual([
      { method: 'POST', path: '/me/change-password' },
      { method: 'PATCH', path: '/me/password' },
    ]);
  });

  it('builds independent wiring per factory call', () => {
    createChangePasswordRouter({ db: makeMockPool(), requireAuth: createAuthenticatedRequireAuth() });
    createChangePasswordRouter({ db: makeMockPool(), requireAuth: createAuthenticatedRequireAuth() });

    expect(userState.instances).toHaveLength(2);
    expect(sessionState.instances).toHaveLength(2);
  });
});

/* ─── POST /me/change-password — success path ────────────────────────────── */

describe('POST /me/change-password — success', () => {
  it('returns 200, persists a NEW hash, and invalidates all sessions', async () => {
    const oldHash = await seedUserWithPassword(CURRENT_PASSWORD);

    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Password updated successfully' });

    expect(userState.findById).toHaveBeenCalledWith(USER_ID);
    expect(userState.updatePasswordHash).toHaveBeenCalledTimes(1);
    const [userIdArg, newHashArg] = userState.updatePasswordHash.mock.calls[0] as [string, string];
    expect(userIdArg).toBe(USER_ID);
    expect(typeof newHashArg).toBe('string');
    expect(newHashArg).not.toBe(oldHash);
    expect(newHashArg).toContain(':');

    // Security contract: every session for the user is revoked on password change.
    expect(sessionState.deleteAllSessionsByUserId).toHaveBeenCalledTimes(1);
    expect(sessionState.deleteAllSessionsByUserId.mock.calls[0][0]).toBe(USER_ID);
  });
});

/* ─── POST /me/change-password — rejected inputs ─────────────────────────── */

describe('POST /me/change-password — rejected inputs', () => {
  it('returns 401 when currentPassword does not match', async () => {
    await seedUserWithPassword('RealPassword159!');

    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: 'WrongPassword159!', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(res.body.message).toMatch(/current password is incorrect/i);

    // No side effects on auth failure.
    expect(userState.updatePasswordHash).not.toHaveBeenCalled();
    expect(sessionState.deleteAllSessionsByUserId).not.toHaveBeenCalled();
  });

  it('returns 400 when body fields are missing', async () => {
    const res = await request(makeApp())
      .post('/me/change-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(userState.findById).not.toHaveBeenCalled();
  });

  it('returns 400 when only currentPassword is provided', async () => {
    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when newPassword fails the strength policy', async () => {
    await seedUserWithPassword(CURRENT_PASSWORD);

    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: WEAK_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/strength requirements/i);
    expect(userState.updatePasswordHash).not.toHaveBeenCalled();
    expect(sessionState.deleteAllSessionsByUserId).not.toHaveBeenCalled();
  });

  it('returns 400 for a password missing required character classes', async () => {
    await seedUserWithPassword(CURRENT_PASSWORD);

    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: 'alllowercaseonly' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when the user id is not found', async () => {
    userState.findById.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(userState.updatePasswordHash).not.toHaveBeenCalled();
    expect(sessionState.deleteAllSessionsByUserId).not.toHaveBeenCalled();
  });

  it('returns 401 when the request is unauthenticated', async () => {
    await seedUserWithPassword(CURRENT_PASSWORD);

    const res = await request(makeApp(createRejectingRequireAuth()))
      .post('/me/change-password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    // requireAuth rejected before the handler ran.
    expect(userState.findById).not.toHaveBeenCalled();
    expect(userState.updatePasswordHash).not.toHaveBeenCalled();
  });
});

/* ─── PATCH /me/password — alias ─────────────────────────────────────────── */

describe('PATCH /me/password — alias', () => {
  it('serves the same success contract as POST /me/change-password', async () => {
    const oldHash = await seedUserWithPassword(CURRENT_PASSWORD);

    const res = await request(makeApp())
      .patch('/me/password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, message: 'Password updated successfully' });
    expect(userState.updatePasswordHash).toHaveBeenCalledTimes(1);
    const [, newHashArg] = userState.updatePasswordHash.mock.calls[0] as [string, string];
    expect(newHashArg).not.toBe(oldHash);
    expect(sessionState.deleteAllSessionsByUserId).toHaveBeenCalledWith(USER_ID, expect.anything());
  });

  it('rejects wrong currentPassword on the alias with 401', async () => {
    await seedUserWithPassword('RealPassword159!');

    const res = await request(makeApp())
      .patch('/me/password')
      .send({ currentPassword: 'WrongPassword159!', newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
    expect(userState.updatePasswordHash).not.toHaveBeenCalled();
  });

  it('enforces requireAuth on the alias', async () => {
    const res = await request(makeApp(createRejectingRequireAuth()))
      .patch('/me/password')
      .send({ currentPassword: CURRENT_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});
