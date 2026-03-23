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
import { validateOfferingCreation, validateOfferingUpdate, validateStatusChange, validationErrorHandler } from "./middleware/offeringValidation";
import { OfferingRepository } from "./db/repositories/offeringRepository";
import { InvestmentRepository } from "./db/repositories/investmentRepository";

const app = express();
const port = process.env.PORT ?? 3000;
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

// Mock repositories for validation matrix (to be replaced with real implementations)
class MockOfferingRepository {
  constructor(private db: any = null) {}
  
  async findById(id: string): Promise<any> {
    return null;
  }
  
  async findByContractAddress(contractAddress: string): Promise<any> {
    return null;
  }
  
  async listAll(): Promise<any[]> {
    return [];
  }
  
  async listByIssuer(issuerUserId: string, filters: any = {}): Promise<any[]> {
    return [];
  }
  
  async create(offering: any): Promise<any> {
    return { id: 'mock-offering-id', ...offering };
  }
  
  async update(id: string, partial: any): Promise<any> {
    return { id, ...partial };
  }
  
  async updateStatus(id: string, status: string): Promise<any> {
    return { id, status };
  }
  
  async updateState(id: string, input: any): Promise<any> {
    return { id, ...input };
  }
  
  async getById(id: string): Promise<any> {
    return null;
  }
  
  async isOwner(offeringId: string, issuerId: string): Promise<boolean> {
    return false;
  }
  
  private mapOffering(row: any): any {
    return row;
  }
}

class MockInvestmentRepository {
  constructor(private db: any = null) {}
  
  async listByInvestor(options: any): Promise<any[]> {
    return [];
  }
  
  async create(input: any): Promise<any> {
    return { id: 'mock-investment-id', ...input };
  }
  
  async findByOffering(offeringId: string): Promise<any[]> {
    return [];
  }
  
  async getAggregateStats(offeringId: string): Promise<any> {
    return { totalInvested: '0', investorCount: 0 };
  }
  
  private mapInvestment(row: any): any {
    return row;
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

// Initialize repositories for validation matrix
const offeringRepository = new MockOfferingRepository();
const investmentRepository = new MockInvestmentRepository();

app.use(createCorsMiddleware());
app.use(express.json());
app.use(morgan("dev"));
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

// Offering validation matrix routes
apiRouter.post('/offerings', 
  requireAuth,
  validateOfferingCreation(offeringRepository, investmentRepository),
  (req: Request, res: Response) => {
    // Validation passed, proceed with offering creation
    const validatedRequest = req as any;
    res.status(201).json({
      message: 'Offering created successfully',
      data: {
        offering: {
          id: 'new-offering-id',
          ...req.body
        }
      },
      validation: validatedRequest.validationResult?.metadata
    });
  }
);

apiRouter.put('/offerings/:id',
  requireAuth,
  validateOfferingUpdate(offeringRepository, investmentRepository),
  (req: Request, res: Response) => {
    // Validation passed, proceed with offering update
    const validatedRequest = req as any;
    res.json({
      message: 'Offering updated successfully',
      data: {
        id: req.params.id,
        ...req.body
      },
      validation: validatedRequest.validationResult?.metadata
    });
  }
);

apiRouter.patch('/offerings/:id/status',
  requireAuth,
  validateStatusChange(offeringRepository, investmentRepository),
  (req: Request, res: Response) => {
    // Validation passed, proceed with status change
    const validatedRequest = req as any;
    res.json({
      message: 'Offering status updated successfully',
      data: {
        id: req.params.id,
        status: req.body.status
      },
      validation: validatedRequest.validationResult?.metadata
    });
  }
);

// Add validation error handler
app.use(validationErrorHandler);

app.get("/health", async (_req: Request, res: Response) => {
  const db = await dbHealth();
  res.status(db.healthy ? 200 : 503).json({
    status: db.healthy ? "ok" : "degraded",
    service: "revora-backend",
    db,
  });
});

app.get("/api/overview", (_req: Request, res: Response) => {
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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`revora-backend listening on http://localhost:${port}`);
});
