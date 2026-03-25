import "dotenv/config";
import express, { Request, Response } from "express";
import morgan from "morgan";
import { dbHealth, closePool } from "./db/client";
import { createCorsMiddleware } from "./middleware/cors";
import createNotificationsRouter, { Notification, NotificationRepo } from "./routes/notifications";
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

class InMemoryNotificationRepository implements NotificationRepo {
  private notifications = new Map<string, Notification[]>();
  private idCounter = 0;

  async listByUser(userId: string): Promise<Notification[]> {
    return this.notifications.get(userId) ?? [];
  }

  async markRead(id: string, userId: string): Promise<boolean> {
    const userNotifications = this.notifications.get(userId) ?? [];
    const note = userNotifications.find((n) => n.id === id);
    if (!note) return false;
    note.read = true;
    return true;
  }

  async markReadBulk(ids: string[], userId: string): Promise<number> {
    const userNotifications = this.notifications.get(userId) ?? [];
    let marked = 0;
    for (const id of ids) {
      const note = userNotifications.find((n) => n.id === id);
      if (note && !note.read) {
        note.read = true;
        marked += 1;
      }
    }
    return marked;
  }

  async create(userId: string, type: string, title: string, body: string): Promise<Notification> {
    const incoming: Notification = {
      id: `notification-${++this.idCounter}`,
      user_id: userId,
      type,
      message: `${title}: ${body}`,
      read: false,
      created_at: new Date(),
    };
    const current = this.notifications.get(userId) ?? [];
    current.unshift(incoming);
    this.notifications.set(userId, current);
    return incoming;
  }
}

interface FanOutResult {
  requested: number;
  delivered: number;
  skipped: number;
  failed: string[];
  idempotent: boolean;
}

const fanOutIdempotency = new Map<string, { hash: string; result: FanOutResult }>();

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
const notificationRepository = new InMemoryNotificationRepository();

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));
/**
 * @dev All API business routes are deliberately scoped under the target version prefix.
 * This establishes an enforced boundary constraint preventing un-versioned fallback leaks.
 */
app.use(API_VERSION_PREFIX, apiRouter);

apiRouter.use(
  createNotificationsRouter({
    notificationRepo: notificationRepository,
    verifyJWT: requireAuth,
  }),
);

apiRouter.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  }),
);

apiRouter.post('/notifications/fanout', requireAuth, async (req: Request, res: Response) => {
  /*
   * security assumptions:
   * - only authenticated requests with role `admin` are allowed to trigger fan-out.
   * - idempotency key is required to avoid double delivery in retries and is stored in memory (best-effort in this in-memory prototype).
   * - request quotas are enforced by max recipients and max payload sizes.
   */

  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const idempotencyKey = String(req.header('x-idempotency-key') || '').trim();
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing x-idempotency-key header' });
  }

  const { type, title, body, recipient_ids: recipientIds } = req.body ?? {};

  if (typeof type !== 'string' || type.trim().length === 0) {
    return res.status(400).json({ error: 'Invalid type' });
  }
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > 240) {
    return res.status(400).json({ error: 'Invalid title' });
  }
  if (typeof body !== 'string' || body.trim().length === 0 || body.length > 1000) {
    return res.status(400).json({ error: 'Invalid body' });
  }
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
    return res.status(400).json({ error: 'recipient_ids must be a non-empty array' });
  }
  if (recipientIds.length > 100) {
    return res.status(400).json({ error: 'Too many recipients (max 100)' });
  }

  const normalized = recipientIds
    .filter((id) => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());

  if (normalized.length === 0) {
    return res.status(400).json({ error: 'No valid recipient IDs' });
  }

  const requestBytes = JSON.stringify({ type, title, body, recipient_ids: normalized });
  const actionsHash = requestBytes;

  const existing = fanOutIdempotency.get(idempotencyKey);
  if (existing) {
    if (existing.hash !== actionsHash) {
      return res.status(409).json({ error: 'Idempotency key collision with different payload' });
    }
    return res.status(200).json({ ...existing.result, cached: true });
  }

  const uniqueRecipientIds = Array.from(new Set(normalized));
  let delivered = 0;
  const failed: string[] = [];

  for (const recipientId of uniqueRecipientIds) {
    try {
      await notificationRepository.create(recipientId, type, title, body);
      delivered += 1;
    } catch (error) {
      // reliability: continue on partial error and record failures
      failed.push(recipientId);
    }
  }

  const result: FanOutResult = {
    requested: uniqueRecipientIds.length,
    delivered,
    skipped: uniqueRecipientIds.length - delivered - failed.length,
    failed,
    idempotent: false,
  };

  fanOutIdempotency.set(idempotencyKey, { hash: actionsHash, result });

  res.status(200).json({ ...result });
});

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
