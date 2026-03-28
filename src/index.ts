import 'dotenv/config';
import { randomUUID } from 'crypto';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import morgan from 'morgan';
import { closePool, dbHealth, query as dbQuery } from './db/client';
import { createCorsMiddleware } from './middleware/cors';
import { errorHandler } from './middleware/errorHandler';
import { Errors } from './lib/errors';
import { createHealthRouter } from './routes/health';
import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from './vaults/milestoneValidationRoute';

const port = process.env.PORT ?? 3000;

/**
 * @dev The global prefix applied to all business logic routers.
 * Defaults to `/api/v1` if `process.env.API_VERSION_PREFIX` is not supplied.
 * Crucial for preventing route conflict and ensuring reliable downstream tooling.
 */
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';

// --- Repository Implementations ---
class InMemoryMilestoneRepository implements MilestoneRepository {
  constructor(private readonly milestones = new Map<string, Milestone>()) { }
  private key(vaultId: string, milestoneId: string): string { return `${vaultId}:${milestoneId}`; }
  async getByVaultAndId(vaultId: string, milestoneId: string): Promise<Milestone | null> {
    return this.milestones.get(this.key(vaultId, milestoneId)) ?? null;
  }
  async markValidated(input: { vaultId: string; milestoneId: string; verifierId: string; validatedAt: Date; }): Promise<Milestone> {
    const key = this.key(input.vaultId, input.milestoneId);
    const current = this.milestones.get(key);

    /* istanbul ignore next -- guarded by pre-check in validate handler */
    if (!current) {
      throw Errors.notFound('Milestone not found');
    }

    const updated: Milestone = {
      ...current,
      status: 'validated',
      validated_by: input.verifierId,
      validated_at: input.validatedAt,
    };

    this.milestones.set(key, updated);
    return updated;
  }
}

class InMemoryVerifierAssignmentRepository implements VerifierAssignmentRepository {
  constructor(private readonly assignments = new Map<string, Set<string>>()) { }
  async isVerifierAssignedToVault(vaultId: string, verifierId: string): Promise<boolean> {
    return this.assignments.get(vaultId)?.has(verifierId) ?? false;
  }
}

class InMemoryMilestoneValidationEventRepository
  implements MilestoneValidationEventRepository
{
  private readonly events: MilestoneValidationEvent[] = [];
  private counter = 0;
  async create(input: { vaultId: string; milestoneId: string; verifierId: string; createdAt: Date; }): Promise<MilestoneValidationEvent> {
    this.counter += 1;

    const event: MilestoneValidationEvent = {
      id: `validation-event-${this.counter}`,
      vault_id: input.vaultId,
      milestone_id: input.milestoneId,
      verifier_id: input.verifierId,
      created_at: input.createdAt,
    };

    this.events.push(event);
    return event;
  }
}

class ConsoleDomainEventPublisher implements DomainEventPublisher {
  async publish(eventName: string, payload: Record<string, unknown>): Promise<void> {
    console.log(`[domain-event] ${eventName}`, payload);
  }
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

  (req as Request & { user?: { id: string; role: string } }).user = {
    id: userId,
    role,
  };

  next();
};

function createMilestoneDependencies() {
  const milestoneRepository = new InMemoryMilestoneRepository(
    new Map<string, Milestone>([
      [
        'vault-1:milestone-1',
        {
          id: 'milestone-1',
          vault_id: 'vault-1',
          status: 'pending',
        },
      ],
    ]),
  );

  const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
    new Map<string, Set<string>>([['vault-1', new Set(['verifier-1'])]]),
  );

  const milestoneValidationEventRepository =
    new InMemoryMilestoneValidationEventRepository();
  const domainEventPublisher = new ConsoleDomainEventPublisher();

  return {
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  };
}

export function createApp(): express.Express {
  const app = express();
  const apiRouter = express.Router();
  const milestoneDeps = createMilestoneDependencies();

  // Import and setup missing routers and services
  const { Pool } = require('pg');
  const pool = new Pool();
  
  // Import missing modules
  const { createLoginRouter } = require('./auth/login/loginRouter');
  const { createRefreshRouter } = require('./auth/refresh/refreshRouter');
  const { OfferingRepository } = require('./db/repositories/offeringRepository');
  const { createReconciliationRouter } = require('./routes/reconciliationRoutes');
  const { createPasswordResetRouter } = require('./auth/passwordReset/passwordResetRouter');
  
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

  apiRouter.use(createPasswordResetRouter(pool));

  app.use((req, _res, next) => {
    (req as Request & { requestId?: string }).requestId =
      req.header('x-request-id') ?? randomUUID();
    next();
  });
  app.use(createCorsMiddleware());
  app.use(express.json());
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

  apiRouter.use(
    createMilestoneValidationRouter({
      requireAuth,
      ...milestoneDeps,
    }),
  );

  app.use(API_VERSION_PREFIX, apiRouter);
  app.use((_req, _res, next) => next(Errors.notFound('Route not found')));
  app.use(errorHandler);

  return app;
}

const app = createApp();

async function shutdown(signal: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n[server] ${signal} shutting down`);
  await closePool();
  process.exit(0);
}

if (require.main === module) {
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  if (process.env.NODE_ENV !== 'test') {
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`revora-backend listening on http://localhost:${port}`);
    });
  }
}

/**
 * Webhook Delivery Backoff Queue
 * Requirements: 95% coverage, SSRF Protection, Exponential Backoff.
 */
export class WebhookQueue {
  private static MAX_RETRIES = 5;
  private static INITIAL_DELAY = 1000; // 1s

  // SSRF Protection: Block internal/private IP ranges
  private static isSafeUrl(url: string): boolean {
    const privateIPs = /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/;
    try {
      const { hostname } = new URL(url);
      return !privateIPs.test(hostname) && hostname !== 'localhost';
    } catch {
      return false;
    }
  }

  /**
   * Calculates delay: 1s, 2s, 4s, 8s, 16s...
   */
  static getBackoffDelay(retryCount: number): number {
    if (retryCount >= this.MAX_RETRIES) return -1;
    return this.INITIAL_DELAY * Math.pow(2, retryCount);
  }

  static async processDelivery(url: string, payload: object, attempt = 0): Promise<boolean> {
    if (!this.isSafeUrl(url)) {
      console.error(`[Security] Blocked unsafe webhook URL: ${url}`);
      return false;
    }

    try {
      // Logic for actual fetch call would go here
      // For now, we simulate a failure to test the backoff
      throw new Error("Simulated Network Failure");
    } catch (err) {
      const nextDelay = this.getBackoffDelay(attempt);
      if (nextDelay !== -1) {
        console.log(`Retrying in ${nextDelay}ms (Attempt ${attempt + 1})`);
        // In production, this would be a job queue like BullMQ
        return new Promise(res => setTimeout(() => res(this.processDelivery(url, payload, attempt + 1)), nextDelay));
      }
      return false; // Max retries exceeded
    }
  }
}

export default app;
