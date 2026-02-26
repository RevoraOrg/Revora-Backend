import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export type MilestoneStatus = 'pending' | 'validated';

export interface Milestone {
  id: string;
  vault_id: string;
  status: MilestoneStatus;
  validated_at?: Date;
  validated_by?: string;
}

export interface MilestoneValidationEvent {
  id: string;
  vault_id: string;
  milestone_id: string;
  verifier_id: string;
  created_at: Date;
}

export interface MilestoneRepository {
  getByVaultAndId(vaultId: string, milestoneId: string): Promise<Milestone | null>;
  markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }): Promise<Milestone>;
}

export interface VerifierAssignmentRepository {
  isVerifierAssignedToVault(vaultId: string, verifierId: string): Promise<boolean>;
}

export interface MilestoneValidationEventRepository {
  create(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    createdAt: Date;
  }): Promise<MilestoneValidationEvent>;
}

export interface DomainEventPublisher {
  publish(eventName: string, payload: Record<string, unknown>): Promise<void>;
}

interface CreateValidateMilestoneRouteDeps {
  requireAuth: RequestHandler;
  milestoneRepository: MilestoneRepository;
  verifierAssignmentRepository: VerifierAssignmentRepository;
  milestoneValidationEventRepository: MilestoneValidationEventRepository;
  domainEventPublisher: DomainEventPublisher;
}

const getUserId = (req: Request): string | undefined => {
  const fromUser = (req as any).user?.id;
  const fromAuth = (req as any).auth?.userId;
  return fromUser ?? fromAuth;
};

const getUserRole = (req: Request): string | undefined => {
  const fromUser = (req as any).user?.role;
  const fromAuth = (req as any).auth?.role;
  return fromUser ?? fromAuth;
};

export const createValidateMilestoneHandler = ({
  milestoneRepository,
  verifierAssignmentRepository,
  milestoneValidationEventRepository,
  domainEventPublisher,
}: Omit<CreateValidateMilestoneRouteDeps, 'requireAuth'>): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const verifierId = getUserId(req);
      const role = getUserRole(req);

      if (!verifierId || !role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (role !== 'verifier') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const vaultId = req.params.id;
      const milestoneId = req.params.mid;

      if (!vaultId || !milestoneId) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      const isAssigned = await verifierAssignmentRepository.isVerifierAssignedToVault(
        vaultId,
        verifierId
      );

      if (!isAssigned) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const milestone = await milestoneRepository.getByVaultAndId(vaultId, milestoneId);

      if (!milestone) {
        res.status(404).json({ error: 'Milestone not found' });
        return;
      }

      if (milestone.status === 'validated') {
        res.status(409).json({ error: 'Milestone already validated' });
        return;
      }

      const now = new Date();

      const validationEvent = await milestoneValidationEventRepository.create({
        vaultId,
        milestoneId,
        verifierId,
        createdAt: now,
      });

      const updatedMilestone = await milestoneRepository.markValidated({
        vaultId,
        milestoneId,
        verifierId,
        validatedAt: now,
      });

      await domainEventPublisher.publish('vault.milestone.validated', {
        validationEventId: validationEvent.id,
        vaultId,
        milestoneId,
        verifierId,
        validatedAt: now.toISOString(),
      });

      res.status(200).json({
        data: {
          milestone: updatedMilestone,
          validationEvent,
        },
      });
    } catch (error) {
      next(error);
    }
  };
};

export const createMilestoneValidationRouter = ({
  requireAuth,
  milestoneRepository,
  verifierAssignmentRepository,
  milestoneValidationEventRepository,
  domainEventPublisher,
}: CreateValidateMilestoneRouteDeps): Router => {
  const router = Router();

  router.post(
    '/vaults/:id/milestones/:mid/validate',
    requireAuth,
    createValidateMilestoneHandler({
      milestoneRepository,
      verifierAssignmentRepository,
      milestoneValidationEventRepository,
      domainEventPublisher,
    })
  );

  return router;
};
