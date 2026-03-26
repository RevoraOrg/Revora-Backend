import "dotenv/config";
import express, { Request, Response } from "express";
import morgan from "morgan";
import { dbHealth, closePool } from "./db/client";
import { createCorsMiddleware } from "./middleware/cors";
import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from "./vaults/milestoneValidationRoute";

const app = express();
const port = process.env.PORT ?? 3000;
/**
 * @dev The global prefix applied to all business logic routers.
 * Defaults to `/api/v1` if `process.env.API_VERSION_PREFIX` is not supplied.
 * Crucial for preventing route conflict and ensuring reliable downstream tooling (e.g. AWS API Gateway handling).
 */
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();

class InMemoryMilestoneRepository implements MilestoneRepository {
  constructor(private readonly milestones = new Map<string, Milestone>()) {}

  private key(vaultId: string, milestoneId: string): string {
    return `${vaultId}:${milestoneId}`;
  }

  async getByVaultAndId(
    vaultId: string,
    milestoneId: string,
  ): Promise<Milestone | null> {
    return this.milestones.get(this.key(vaultId, milestoneId)) ?? null;
  }

  async markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }): Promise<Milestone> {
    const key = this.key(input.vaultId, input.milestoneId);
    const current = this.milestones.get(key);

    if (!current) {
      throw new Error("Milestone not found");
    }

    const updated: Milestone = {
      ...current,
      status: "validated",
      validated_by: input.verifierId,
      validated_at: input.validatedAt,
    };
    this.milestones.set(key, updated);
    return updated;
  }
}

class InMemoryVerifierAssignmentRepository implements VerifierAssignmentRepository {
  constructor(private readonly assignments = new Map<string, Set<string>>()) {}

  async isVerifierAssignedToVault(
    vaultId: string,
    verifierId: string,
  ): Promise<boolean> {
    return this.assignments.get(vaultId)?.has(verifierId) ?? false;
  }
}

class InMemoryMilestoneValidationEventRepository implements MilestoneValidationEventRepository {
  private events: MilestoneValidationEvent[] = [];
  private counter = 0;

  async create(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    createdAt: Date;
  }): Promise<MilestoneValidationEvent> {
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
  async publish(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[domain-event] ${eventName}`, payload);
  }
}

const requireAuth = (req: Request, res: Response, next: () => void): void => {
  const userId = req.header("x-user-id");
  const role = req.header("x-user-role");

  if (!userId || !role) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  (req as any).user = {
    id: userId,
    role,
  };

  next();
};

const milestoneRepository = new InMemoryMilestoneRepository(
  new Map<string, Milestone>([
    [
      "vault-1:milestone-1",
      {
        id: "milestone-1",
        vault_id: "vault-1",
        status: "pending",
      },
    ],
  ]),
);
const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
  new Map<string, Set<string>>([["vault-1", new Set(["verifier-1"])]]),
);
const milestoneValidationEventRepository =
  new InMemoryMilestoneValidationEventRepository();
const domainEventPublisher = new ConsoleDomainEventPublisher();

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));
/**
 * @dev All API business routes are deliberately scoped under the target version prefix.
 * This establishes an enforced boundary constraint preventing un-versioned fallback leaks.
 */
app.use(API_VERSION_PREFIX, apiRouter);

apiRouter.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  }),
);

/**
 * @notice Operational route explicitly bypassing the API prefix boundary.
 * @dev Used generically by load balancers and orchestrators without coupling them to specific versions.
 */
app.get("/health", async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? "ok" : "degraded",
    service: "revora-backend",
    db,
  });
});

interface IdempotencyRecord {
  status: "processing" | "completed";
  response?: any;
  expiresAt: number;
}

const idempotencyStore = new Map<string, IdempotencyRecord>();

export const clearIdempotencyStore = () => idempotencyStore.clear();

/**
 * @dev Investment Double-Submit Protection Middleware
 * Security Assumptions:
 * 1. An idempotency key is required (`x-idempotency-key`).
 * 2. The key is namespaced by the user ID to prevent cross-account collisions.
 * 3. Concurrent identical requests will receive a 409 Conflict.
 * 4. Completed identical requests will receive the cached response (200 OK).
 */
export const investmentDoubleSubmitProtection = (req: Request, res: Response, next: () => void): void => {
  const idempotencyKey = req.header("x-idempotency-key");

  if (!idempotencyKey) {
    res.status(400).json({ error: "Missing x-idempotency-key header" });
    return;
  }

  const userId = (req as any).user?.id;
  
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const namespacedKey = `${userId}:${idempotencyKey}`;
  const now = Date.now();
  const existingRecord = idempotencyStore.get(namespacedKey);

  if (existingRecord) {
    if (existingRecord.expiresAt < now) {
      idempotencyStore.delete(namespacedKey);
    } else if (existingRecord.status === "processing") {
      res.status(409).json({ error: "Concurrent request detected" });
      return;
    } else if (existingRecord.status === "completed") {
      res.status(200).json(existingRecord.response);
      return;
    }
  }

  idempotencyStore.set(namespacedKey, {
    status: "processing",
    expiresAt: now + 24 * 60 * 60 * 1000,
  });

  const originalJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    // Only cache 2xx responses
    if (res.statusCode >= 200 && res.statusCode < 300) {
      idempotencyStore.set(namespacedKey, {
        status: "completed",
        response: body,
        expiresAt: now + 24 * 60 * 60 * 1000,
      });
    } else {
      // In case of error, delete the processing state so the user can retry
      idempotencyStore.delete(namespacedKey);
    }
    return originalJson(body);
  };

  next();
};

apiRouter.post('/invest', requireAuth, investmentDoubleSubmitProtection, (req: Request, res: Response) => {
  res.status(200).json({ status: "success", message: "Investment processed" });
});

apiRouter.get('/overview', (_req: Request, res: Response) => {
  res.json({
    name: "Stellar RevenueShare (Revora) Backend",
    description:
      "Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).",
  });
});

const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} DB shutting down…`);
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`revora-backend listening on http://localhost:${port}`);
  });
}

export default app;
