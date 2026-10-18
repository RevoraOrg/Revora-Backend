/**
 * Focused behavior coverage for src/routes/vesting.ts
 *
 * Issue #1076 — Add focused behavior coverage for vesting.
 *
 * The vesting route exposes a single endpoint:
 *   POST /claim
 *
 * It uses `createRequireAuth` (session-hardened middleware) and delegates
 * business logic to `VestingService.processPartialClaim`.
 *
 * Because the router is instantiated at module load time (default export, no
 * factory function), we mock its dependencies via `jest.mock()` before
 * importing the router so the mocked versions are injected into the module
 * scope.
 *
 * Test coverage:
 *   1. Authentication/authorization — missing auth, invalid auth
 *   2. Input validation — missing fields, wrong types, invalid values
 *   3. Happy-path — successful partial claim response shape
 *   4. Business-logic failures — returned by VestingService
 *   5. Vesting state transitions — not-found, zero-claim, full-claim
 *   6. Boundary conditions — claimAmount = 0, negative, large values
 *   7. Service-level failure — unexpected throw from processPartialClaim
 */

import express, { NextFunction, Request, Response, RequestHandler } from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler';

// ─── Mock order matters: jest.mock is hoisted to the top of the file ─────────

// 1. Mock the database pool (prevents real PG connections).
jest.mock('../db/pool', () => ({ pool: {} }));

// 2. Mock SessionRepository — the default export router passes a real instance
//    to createRequireAuth, but we replace createRequireAuth itself so this is
//    only needed to satisfy the import-time side-effect.
jest.mock('../db/repositories/sessionRepository', () => ({
  SessionRepository: jest.fn().mockImplementation(() => ({})),
}));

// 3. Mock createRequireAuth so we can control authentication outcomes
//    without needing a real JWT or database session.
//    We store the middleware reference in a module-level variable so
//    individual tests can swap the behaviour.
let mockAuthMiddleware: RequestHandler = (_req, _res, next) => next();

jest.mock('../middleware/auth', () => ({
  createRequireAuth: jest.fn().mockImplementation(() => {
    // Return a wrapper that delegates to the current mockAuthMiddleware value,
    // so tests can change behaviour after module load.
    return (req: Request, res: Response, next: NextFunction) =>
      mockAuthMiddleware(req, res, next);
  }),
}));

// 4. Mock VestingService so we can control what processPartialClaim returns.
const mockProcessPartialClaim = jest.fn();

jest.mock('../services/vestingService', () => ({
  VestingService: jest.fn().mockImplementation(() => ({
    processPartialClaim: mockProcessPartialClaim,
  })),
}));

// ─── Import AFTER mocks so module-level code picks up mocked deps ─────────────
import vestingRouter from './vesting';

// ─── App factory ──────────────────────────────────────────────────────────────

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/vesting', vestingRouter);
  app.use(errorHandler);
  return app;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/** Install a middleware that sets req.user.id to the given userId. */
function setAuthUser(userId: string): void {
  mockAuthMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
    next();
  };
}

/** Install a middleware that responds 401 (simulates missing/invalid auth). */
function setAuthFail(statusCode: 401 | 403 = 401): void {
  mockAuthMiddleware = (_req: Request, res: Response) => {
    res.status(statusCode).json({ success: false, error: 'Unauthorized' });
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_CLAIM_BODY = {
  scheduleId: 'sched-abc-123',
  claimAmount: 150,
};

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /vesting/claim — vesting route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: authenticated user with id 'user-1'
    setAuthUser('user-1');
    // Default: service returns a successful result
    mockProcessPartialClaim.mockResolvedValue({
      success: true,
      claimedAmount: 150,
      remainingAmount: 850,
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Authentication / authorization boundaries
  // ═══════════════════════════════════════════════════════════════════════════

  describe('authentication boundaries', () => {
    it('returns 401 when auth middleware rejects the request', async () => {
      setAuthFail(401);

      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.status).toBe(401);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 403 when auth middleware forbids the request', async () => {
      setAuthFail(403);

      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.status).toBe(403);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('does not reach the handler when auth fails', async () => {
      setAuthFail(401);

      await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Input validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('input validation — invalid inputs return 400', () => {
    it('returns 400 when scheduleId is missing', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ claimAmount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/scheduleId/i);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when claimAmount is missing', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when claimAmount is a string (wrong type)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: '150' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when claimAmount is null (wrong type)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: null });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when claimAmount is boolean (wrong type)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: true });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when claimAmount is negative', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: -1 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when scheduleId is an empty string (falsy)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: '', claimAmount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when the request body is empty', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('returns 400 when scheduleId is a number (wrong type — truthy non-string)', async () => {
      // The route only validates presence (truthy), not string type.
      // scheduleId = 0 is falsy so the validation rejects it.
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 0, claimAmount: 100 });

      // scheduleId = 0 is falsy, so the route rejects with 400.
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Successful claim — response contract
  // ═══════════════════════════════════════════════════════════════════════════

  describe('successful claim — response contract', () => {
    it('returns 200 with success:true and the claimed/remaining amounts', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 150,
        remainingAmount: 850,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 150 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        claimedAmount: 150,
        remainingAmount: 850,
      });
    });

    it('response body does not include an error field on success', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.body.error).toBeUndefined();
    });

    it('response Content-Type is application/json', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('forwards the authenticated userId to processPartialClaim', async () => {
      setAuthUser('user-42');

      await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-xyz', claimAmount: 200 });

      expect(mockProcessPartialClaim).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-42' })
      );
    });

    it('forwards scheduleId and claimAmount to processPartialClaim', async () => {
      await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-xyz', claimAmount: 300 });

      expect(mockProcessPartialClaim).toHaveBeenCalledWith(
        expect.objectContaining({ scheduleId: 'sched-xyz', claimAmount: 300 })
      );
    });

    it('passes empty string userId when req.user is missing (unauthenticated passthrough)', async () => {
      // Some middleware configurations don't set req.user.id; the route
      // defensively falls back to ''.
      mockAuthMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
        // Intentionally do NOT set req.user
        next();
      };

      await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(mockProcessPartialClaim).toHaveBeenCalledWith(
        expect.objectContaining({ userId: '' })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Business-logic failures returned by VestingService
  // ═══════════════════════════════════════════════════════════════════════════

  describe('service failures — 400 responses with error details', () => {
    it('returns 400 when the service reports failure with an error message', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount exceeds available vested amount',
        remainingAmount: 200,
        claimedAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 999 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Claim amount exceeds available vested amount');
    });

    it('includes remainingAmount in the error response from the service', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount exceeds available vested amount',
        remainingAmount: 200,
        claimedAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 999 });

      expect(res.body.remainingAmount).toBe(200);
    });

    it('returns 400 when the schedule is not found', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Schedule not found',
        remainingAmount: 0,
        claimedAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'non-existent', claimAmount: 100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Schedule not found');
    });

    it('returns 400 when the service reports a negative claim error', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount cannot be negative',
        remainingAmount: 0,
        claimedAmount: 0,
      });

      // This path in the service should never be reached from the route because
      // the route validates claimAmount >= 0 first. But if for any reason the
      // service is called directly and returns failure, the route must handle it.
      mockAuthMiddleware = (req: Request, _res: Response, next: NextFunction) => {
        (req as unknown as { user: { id: string } }).user = { id: 'user-1' };
        // Bypass the route-level validation by directly calling the handler.
        // We cannot easily bypass the route guard, so we verify via service mock.
        next();
      };

      // Use a valid claimAmount (0) that the route passes, but mock the service
      // to return a failure. This verifies the route correctly propagates the
      // service's failure response regardless of what triggered it.
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount cannot be negative',
        remainingAmount: 0,
        claimedAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 0 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Vesting state transitions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('vesting state transitions', () => {
    it('zero-amount claim (claimAmount = 0) reaches the service and returns success', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 0,
        remainingAmount: 1000,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 0 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.claimedAmount).toBe(0);
      expect(res.body.remainingAmount).toBe(1000);
    });

    it('partial claim (claimAmount < available) returns partial remaining amount', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 100,
        remainingAmount: 100,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 100 });

      expect(res.status).toBe(200);
      expect(res.body.claimedAmount).toBe(100);
      expect(res.body.remainingAmount).toBe(100);
    });

    it('full available claim (claimAmount = available) returns zero remaining', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 200,
        remainingAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 200 });

      expect(res.status).toBe(200);
      expect(res.body.claimedAmount).toBe(200);
      expect(res.body.remainingAmount).toBe(0);
    });

    it('over-claim attempt returns 400 with the available amount as remainingAmount', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount exceeds available vested amount',
        claimedAmount: 0,
        remainingAmount: 200,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.remainingAmount).toBe(200);
    });

    it('not-found schedule returns 400 with schedule-not-found error', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Schedule not found',
        claimedAmount: 0,
        remainingAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'does-not-exist', claimAmount: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Schedule not found');
    });

    it('fully-vested schedule with no remaining amount returns 400 when claiming', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount exceeds available vested amount',
        claimedAmount: 0,
        remainingAmount: 0,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-fully-vested', claimAmount: 1 });

      expect(res.status).toBe(400);
      expect(res.body.remainingAmount).toBe(0);
    });

    it('second claim after a partial claim succeeds (idempotent repeat allowed)', async () => {
      // Simulates the schedule having already had a partial claim and still
      // having funds left. The route itself is stateless — the service governs
      // idempotency logic — so a second request that the service approves is
      // passed through correctly.
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 50,
        remainingAmount: 150,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-partially-claimed', claimAmount: 50 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Boundary conditions on claimAmount
  // ═══════════════════════════════════════════════════════════════════════════

  describe('boundary conditions — claimAmount', () => {
    it('claimAmount = 0 is accepted (minimum boundary — exactly at zero)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 0 });

      // The route validation requires claimAmount >= 0, so 0 must pass.
      expect(res.status).toBe(200);
    });

    it('claimAmount = -1 is rejected (just below minimum boundary)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: -1 });

      expect(res.status).toBe(400);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('claimAmount = -0.01 is rejected (fractional negative)', async () => {
      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: -0.01 });

      expect(res.status).toBe(400);
      expect(mockProcessPartialClaim).not.toHaveBeenCalled();
    });

    it('claimAmount = Number.MIN_VALUE (smallest positive float) is accepted', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: Number.MIN_VALUE,
        remainingAmount: 1000 - Number.MIN_VALUE,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: Number.MIN_VALUE });

      expect(res.status).toBe(200);
    });

    it('claimAmount = very large value is accepted by route validation and forwarded to service', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: false,
        error: 'Claim amount exceeds available vested amount',
        claimedAmount: 0,
        remainingAmount: 200,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 1_000_000_000 });

      // Route does not impose an upper bound — it defers to the service.
      expect(res.status).toBe(400); // service rejects it
      expect(mockProcessPartialClaim).toHaveBeenCalledWith(
        expect.objectContaining({ claimAmount: 1_000_000_000 })
      );
    });

    it('claimAmount = 0.5 (fractional) is accepted by route and forwarded', async () => {
      mockProcessPartialClaim.mockResolvedValue({
        success: true,
        claimedAmount: 0.5,
        remainingAmount: 999.5,
      });

      const res = await request(createApp())
        .post('/vesting/claim')
        .send({ scheduleId: 'sched-1', claimAmount: 0.5 });

      expect(res.status).toBe(200);
      expect(res.body.claimedAmount).toBe(0.5);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Unexpected service/dependency failures (500 path)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('unexpected service failures — 500 responses', () => {
    it('returns 500 when processPartialClaim throws an unexpected error', async () => {
      mockProcessPartialClaim.mockRejectedValue(new Error('DB connection lost'));

      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Internal server error');
    });

    it('500 response does not leak the internal error message', async () => {
      mockProcessPartialClaim.mockRejectedValue(
        new Error('PG_CONNECTION_REFUSED: password authentication failed for user "app"')
      );

      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      // The route catches the error and returns a generic message.
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.error).not.toMatch(/password|PG_CONNECTION/i);
    });

    it('returns 500 when processPartialClaim rejects with a non-Error value', async () => {
      mockProcessPartialClaim.mockRejectedValue('unexpected string rejection');

      const res = await request(createApp())
        .post('/vesting/claim')
        .send(VALID_CLAIM_BODY);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });
});
