import "dotenv/config";
import express, { Request, Response } from "express";
import morgan from "morgan";
import { z } from "zod"; // Added for production-grade validation
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

/** * ISSUE #134: Startup Registration Validation Schema
 * Implements security assumptions: whitelisting, length limits, and format integrity.
 */
export const StartupRegistrationSchema = z.object({
  startupName: z.string().min(3, "Name too short").max(100, "Name exceeds limit").trim(),
  registrationId: z.string().regex(/^[a-zA-Z0-9-]+$/, "Alphanumeric and hyphens only"),
  sector: z.enum(["Fintech", "Agrotech", "Healthtech", "SaaS", "Other"]),
  contactEmail: z.string().email("Invalid email format").toLowerCase(),
}).strict(); // Prevents additional malicious fields

const app = express();
const port = process.env.PORT ?? 3000;
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();

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
    if (!current) throw new Error("Milestone not found");
    const updated: Milestone = { ...current, status: "validated", validated_by: input.verifierId, validated_at: input.validatedAt };
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

class InMemoryMilestoneValidationEventRepository implements MilestoneValidationEventRepository {
  private events: MilestoneValidationEvent[] = [];
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

// --- Middleware ---
const requireAuth = (req: Request, res: Response, next: () => void): void => {
  const userId = req.header("x-user-id");
  const role = req.header("x-user-role");
  if (!userId || !role) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).user = { id: userId, role };
  next();
};

// --- Initialization ---
const milestoneRepository = new InMemoryMilestoneRepository(
  new Map([["vault-1:milestone-1", { id: "milestone-1", vault_id: "vault-1", status: "pending" }]])
);
const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
  new Map([["vault-1", new Set(["verifier-1"])]])
);
const milestoneValidationEventRepository = new InMemoryMilestoneValidationEventRepository();
const domainEventPublisher = new ConsoleDomainEventPublisher();

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));

// --- Routes ---
app.use(API_VERSION_PREFIX, apiRouter);

apiRouter.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  })
);

/**
 * POST /startups/register
 * Implementation for Issue #134
 */
apiRouter.post("/startups/register", requireAuth, (req: Request, res: Response) => {
  const result = StartupRegistrationSchema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      status: "error",
      message: "Validation Failed",
      details: result.error.issues.map((err) => ({
        path: err.path.join('.'),
        message: err.message
      }))
    });
  }

  // At this stage, result.data is sanitized and type-safe
  res.status(201).json({
    status: "success",
    message: "Startup registration validated",
    data: result.data
  });
});

apiRouter.get('/overview', (_req: Request, res: Response) => {
  res.json({
    name: "Stellar RevenueShare (Revora) Backend",
    description: "Backend API skeleton for tokenized revenue-sharing on Stellar.",
  });
});

app.get("/health", async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? "ok" : "degraded",
    service: "revora-backend",
    db,
  });
});

// --- Server Lifecycle ---
const shutdown = async (signal: string) => {
  console.log(`\n[server] ${signal} DB shutting down…`);
  await closePool();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(port, () => {
  console.log(`revora-backend listening on http://localhost:${port}`);
});