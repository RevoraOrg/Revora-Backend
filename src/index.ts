import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import {
  createMilestoneValidationRouter,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from './vaults/milestoneValidationRoute';

const app = express();
const port = process.env.PORT ?? 4000;

class InMemoryMilestoneRepository implements MilestoneRepository {
  constructor(private readonly milestones = new Map<string, Milestone>()) {}

  private key(vaultId: string, milestoneId: string): string {
    return `${vaultId}:${milestoneId}`;
  }

  async getByVaultAndId(vaultId: string, milestoneId: string): Promise<Milestone | null> {
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
      throw new Error('Milestone not found');
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
  constructor(private readonly assignments = new Map<string, Set<string>>()) {}

  async isVerifierAssignedToVault(vaultId: string, verifierId: string): Promise<boolean> {
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
  async publish(eventName: string, payload: Record<string, unknown>): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[domain-event] ${eventName}`, payload);
  }
}

const requireAuth = (req: Request, res: Response, next: () => void): void => {
  const userId = req.header('x-user-id');
  const role = req.header('x-user-role');

  if (!userId || !role) {
    res.status(401).json({ error: 'Unauthorized' });
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
      'vault-1:milestone-1',
      {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending',
      },
    ],
  ])
);
const verifierAssignmentRepository = new InMemoryVerifierAssignmentRepository(
  new Map<string, Set<string>>([
    ['vault-1', new Set(['verifier-1'])],
  ])
);
const milestoneValidationEventRepository = new InMemoryMilestoneValidationEventRepository();
const domainEventPublisher = new ConsoleDomainEventPublisher();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(
  createMilestoneValidationRouter({
    requireAuth,
    milestoneRepository,
    verifierAssignmentRepository,
    milestoneValidationEventRepository,
    domainEventPublisher,
  })
);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'revora-backend' });
});

app.get('/api/overview', (_req: Request, res: Response) => {
  res.json({
    name: 'Stellar RevenueShare (Revora) Backend',
    description:
      'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).'
  });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`revora-backend listening on http://localhost:${port}`);
});
