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

apiRouter.use(createLoginRouter({ loginService }));
apiRouter.use(createRefreshRouter({ refreshService }));

/**
 * Main Express application entrypoint.
 *
 * Security assumptions:
 * - only `AppError` instances are allowed to control client-visible messages;
 * - unknown failures are sanitized by the global error handler;
 * - request ids are generated per request to correlate server-side logs.
 *
 * Operational note:
 * - `/health` remains intentionally un-versioned for load balancers/orchestrators.
 * - business logic routes remain scoped under `API_VERSION_PREFIX`.
 */
export function createApp(): express.Express {
  const app = express();
  const apiRouter = express.Router();
  const milestoneDeps = createMilestoneDependencies();

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

export default app;