import 'dotenv/config';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import morgan from 'morgan';
import { closePool, dbHealth, pool, query as dbQuery } from './db/client';
import { createCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { createIdempotencyMiddleware } from './middleware/idempotency';
import { requestIdMiddleware } from './middleware/requestId';
import { createRateLimitMiddleware } from './middleware/rateLimit';
import { Errors } from './lib/errors';
import { createHealthRouter } from './routes/health';
import { StellarSubmissionService } from './services/stellarSubmissionService';
import { createSanitizationMiddleware } from './middleware/sanitization';

/**
 * @dev Classifies failures from Stellar RPC providers into stable categories.
 */
export enum StellarRPCFailureClass {
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  UPSTREAM_ERROR = 'UPSTREAM_ERROR',
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  UNAUTHORIZED = 'UNAUTHORIZED',
  UNKNOWN = 'UNKNOWN',
}

/**
 * @dev Maps raw upstream errors into deterministic failure classes.
 * Security assumption: raw upstream messages are never surfaced to clients.
 */
export function classifyStellarRPCFailure(error: unknown): StellarRPCFailureClass {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))
  ) {
    return StellarRPCFailureClass.TIMEOUT;
  }

  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: number }).status;
    if (status === 429) return StellarRPCFailureClass.RATE_LIMIT;
    if (status === 401 || status === 403) return StellarRPCFailureClass.UNAUTHORIZED;
    if (typeof status === 'number' && status >= 500) {
      return StellarRPCFailureClass.UPSTREAM_ERROR;
    }
  }

  if (error instanceof SyntaxError) {
    return StellarRPCFailureClass.MALFORMED_RESPONSE;
  }

  return StellarRPCFailureClass.UNKNOWN;
}

import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from './vaults/milestoneValidationRoute';
import { createRegisterRouter } from './auth/register/registerRoute';
import {
  InMemoryIdempotencyStore,
} from './middleware/idempotency';
import { createLoginRouter } from './auth/login/loginRoute';
import { createRefreshRouter } from './auth/refresh/refreshRoute';
import { createReconciliationRouter } from './routes/reconciliationRoutes';
import { createPasswordResetRouter } from './routes/passwordReset';
import { createStartupAuthRouter } from './routes/startupAuth';
import createPayoutsRouter from './routes/payouts';
import { OfferingRepository } from './db/repositories/offeringRepository';
import { LoginService } from './auth/login/loginService';
import { RefreshService } from './auth/refresh/refreshService';
import { UserRepository } from './db/repositories/userRepository';
import { SessionRepository } from './db/repositories/sessionRepository';
import { JwtTokenServiceAdapter } from './auth/refresh/tokenServiceAdapter';
import { RefreshTokenRepositoryAdapter } from './auth/refresh/repositoryAdapter';

const port = process.env.PORT ?? 3000;
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';

type AuthenticatedRequest = Request & {
  user?: { id: string; role: string; sessionToken: string };
};

/**
 * @dev Stable JSON serializer used to build deterministic idempotency fingerprints.
 */
function stableSerialize(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }
    return input;
  };

  return JSON.stringify(normalize(value));
}

function isValidStellarPublicKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Z2-7]{56}$/.test(value) &&
    value.startsWith('G')
  );
}

function isValidStellarAmount(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  if (!/^\d+(\.\d{1,7})?$/.test(value)) {
    return false;
  }
  return Number(value) > 0;
}

/**
 * @dev Creates a router for startup-specific registration.
 * Explicitly sanitizes and validates registration inputs.
 */
function createStartupRegisterRouter(): express.Router {
  const router = express.Router();

  /**
   * @dev POST /register
   * Boundary assumption: email and password must be non-empty strings.
   * Security note: Sanitization middleware cleans the inputs before this handler.
   */
  router.post('/register', (req: Request, res: Response) => {
    const { email, password } = req.body as {
      email?: unknown;
      password?: unknown;
    };

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    res.status(201).json({ message: 'Startup user registered successfully' });
  });

  return router;
}

const requireAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
): void => {
  const userId = req.header('x-user-id');
  const role = req.header('x-user-role');

  if (!userId || !role) {
    next(Errors.unauthorized());
    return;
  }

  (req as AuthenticatedRequest).user = {
    id: userId,
    role,
    sessionToken: 'static-id-token',
  };

  next();
};

let stellarSubmissionService: StellarSubmissionService | null = null;

function resetStellarSubmissionService(): void {
  stellarSubmissionService = null;
}

function getStellarSubmissionService(): StellarSubmissionService {
  if (!stellarSubmissionService) {
    stellarSubmissionService = new StellarSubmissionService();
  }
  return stellarSubmissionService;
}

const stellarSubmissionIdempotency = createIdempotencyMiddleware({
  methods: ['POST'],
  shouldStoreResponse: (statusCode) => statusCode >= 200 && statusCode < 300,
  fingerprint: (req) =>
    stableSerialize({
      userId: (req as AuthenticatedRequest).user?.id ?? null,
      body: req.body ?? null,
    }),
});

export function createApp(): express.Express {
  const app = express();
  const apiRouter = express.Router();
  const milestoneDeps = createMilestoneDependencies();
  const notificationRepo = new PostgresNotificationRepo(pool);

  // Mock services for now
  const loginService = {};
  const refreshService = {};

  apiRouter.use(createLoginRouter({ loginService }));
  apiRouter.use(createRefreshRouter({ refreshService }));

  const offeringRepository = new OfferingRepository(pool);
  apiRouter.use(
    "/reconciliation",
    createReconciliationRouter({
      db: pool,
      offeringRepo: offeringRepository,
      requireAuth,
    }),
  );

  app.use(requestIdMiddleware());
  app.use(createCorsMiddleware() as RequestHandler);
  app.use(express.json());
  
  /** 
   * @dev Harden all inputs (body, query, params) against null bytes, control chars, 
   * and common injection vectors by scrubbing them at the boundary.
   */
  app.use(createSanitizationMiddleware());
  
  app.use(morgan('dev'));

  app.get('/health', async (_req: Request, res: Response) => {
    const db = await dbHealth();
    res.status(db.healthy ? 200 : 503).json({
      status: db.healthy ? 'ok' : 'degraded',
      service: 'revora-backend',
      db,
    });
  });

  app.use('/health', createHealthRouter({ query: dbQuery }));

  apiRouter.get('/overview', (_req: Request, res: Response) => {
    res.json({
      name: 'Stellar RevenueShare (Revora) Backend',
      description:
        'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).',
      version: '0.1.0',
    });
  });

  // Mount business logic routes
  // startupAuthLimiter: passthrough until a real rate-limit store is wired up
  const startupAuthLimiter: express.RequestHandler = (_req, _res, next) => next();
  apiRouter.use('/startup', startupAuthLimiter, createStartupAuthRouter(pool));

  apiRouter.use('/startup', startupAuthLimiter, createStartupRegisterRouter());

  apiRouter.post(
    '/stellar/submit-payment',
    requireAuth,
    stellarSubmissionIdempotency,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const idempotencyKey = req.header('idempotency-key')?.trim();
        if (!idempotencyKey) {
          next(Errors.badRequest('Idempotency-Key header is required'));
          return;
        }

        const destination = (req.body as { destination?: unknown })?.destination;
        const amount = (req.body as { amount?: unknown })?.amount;

        if (!isValidStellarPublicKey(destination) || !isValidStellarAmount(amount)) {
          next(
            Errors.badRequest('Invalid Stellar payment payload', {
              destination: 'Expected Stellar public key (G... with 56 chars)',
              amount: 'Expected positive numeric string with up to 7 decimals',
            }),
          );
          return;
        }

        const service = getStellarSubmissionService();
        const result = await service.submitPayment(destination, amount);

        res.status(201).json({
          status: 'submitted',
          result,
        });
      } catch (error) {
        const failureClass = classifyStellarRPCFailure(error);
        next(
          Errors.serviceUnavailable('Stellar submission failed', {
            dependency: 'stellar-horizon',
            failureClass,
          }),
        );
      }
    },
  );

  // --- Payout Filters & Pagination (Issue #149) ---
  const payoutRepo = { listPayoutsByInvestor: async () => [] };
  app.use(createPayoutsRouter({ payoutRepo, verifyJWT: requireAuth }));

  // ── Investor Registration with Idempotency ─────────────────────────────────
  //
  // @dev Idempotency prevents duplicate account creation on client retries
  // (e.g. network timeouts, mobile reconnects).  A 24-hour TTL covers any
  // realistic retry window while bounding memory growth.
  //
  // Security assumptions:
  //  - Keys are caller-supplied opaque strings; no PII should be embedded.
  //  - The in-memory store is single-process; a distributed deployment must
  //    replace it with a Redis-backed IdempotencyStore implementation.
  //  - Cached 409 responses (duplicate email) are also replayed, preventing
  //    a client from probing whether an email exists via re-submission.
  //  - 5xx responses are never cached; a failed first attempt is always retryable.
  const registrationIdempotencyStore = new InMemoryIdempotencyStore({
    ttlMs: 24 * 60 * 60 * 1000,
  });
  app.use(
    '/api/auth/investor/register',
    createIdempotencyMiddleware({
      store: registrationIdempotencyStore,
      methods: ['POST'],
    }),
  );
  const registerUserRepository = new UserRepository(pool);
  app.use(
    createRegisterRouter({
      userRepository: {
        findByEmail: (email) => registerUserRepository.findByEmail(email),
        createUser: (input) => registerUserRepository.createUser(input),
      },
    }),
  );

  app.use(API_VERSION_PREFIX, apiRouter);
  app.use((_req, _res, next) => next(Errors.notFound('Route not found')));
  app.use(errorHandler);

  return app;
}

export const __test = {
  stableSerialize,
  isValidStellarPublicKey,
  isValidStellarAmount,
  resetStellarSubmissionService,
};

export const app = createApp();

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] ${signal} shutting down`);
  await closePool();
  process.exit(0);
}

let server: any;
export const setServer = (s: any) => {
  server = s;
};

if (require.main === module) {
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  if (process.env.NODE_ENV !== 'test') {
    server = app.listen(port, () => {
      console.log(`revora-backend listening on http://localhost:${port}`);
    });
  }
}

/**
 * Webhook Delivery Backoff Queue.
 */
export class WebhookQueue {
  private static MAX_RETRIES = 5;
  private static INITIAL_DELAY = 1000;

  private static isSafeUrl(url: string): boolean {
    const privateIPs = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
    try {
      const { hostname } = new URL(url);
      return !privateIPs.test(hostname) && hostname !== 'localhost';
    } catch {
      return false;
    }
  }

  static getBackoffDelay(retryCount: number): number {
    if (retryCount >= this.MAX_RETRIES) return -1;
    return this.INITIAL_DELAY * Math.pow(2, retryCount);
  }

  static async processDelivery(
    url: string,
    payload: object,
    attempt = 0,
  ): Promise<boolean> {
    void payload;

    if (!this.isSafeUrl(url)) {
      console.error(`[Security] Blocked unsafe webhook URL: ${url}`);
      return false;
    }

    try {
      throw new Error('Simulated Network Failure');
    } catch {
      const nextDelay = this.getBackoffDelay(attempt);
      if (nextDelay !== -1) {
        console.log(`Retrying in ${nextDelay}ms (Attempt ${attempt + 1})`);
        return new Promise((resolve) => {
          setTimeout(() => {
            void this.processDelivery(url, payload, attempt + 1).then(resolve);
          }, nextDelay);
        });
      }
      return false;
    }
  }
}

export default app;
