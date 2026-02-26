import { NextFunction, Request, Response } from 'express';
import {
  createValidateMilestoneHandler,
  DomainEventPublisher,
  Milestone,
  MilestoneRepository,
  MilestoneValidationEvent,
  MilestoneValidationEventRepository,
  VerifierAssignmentRepository,
} from './milestoneValidationRoute';

const mockMilestoneRepository: jest.Mocked<MilestoneRepository> = {
  getByVaultAndId: jest.fn(),
  markValidated: jest.fn(),
};

const mockVerifierAssignmentRepository: jest.Mocked<VerifierAssignmentRepository> = {
  isVerifierAssignedToVault: jest.fn(),
};

const mockValidationEventRepository: jest.Mocked<MilestoneValidationEventRepository> = {
  create: jest.fn(),
};

const mockDomainEventPublisher: jest.Mocked<DomainEventPublisher> = {
  publish: jest.fn(),
};

const createResponse = (): Response => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createNext = (): NextFunction => jest.fn();

const createRequest = (
  overrides: Partial<Request> & {
    params?: Record<string, string>;
    userId?: string;
    role?: string;
  }
): Request => {
  const req = {
    params: overrides.params ?? { id: 'vault-1', mid: 'milestone-1' },
    user: overrides.userId
      ? {
          id: overrides.userId,
          role: overrides.role,
        }
      : undefined,
  } as unknown as Request;

  return req;
};

const pendingMilestone: Milestone = {
  id: 'milestone-1',
  vault_id: 'vault-1',
  status: 'pending',
};

const validationEvent: MilestoneValidationEvent = {
  id: 'validation-event-1',
  vault_id: 'vault-1',
  milestone_id: 'milestone-1',
  verifier_id: 'verifier-1',
  created_at: new Date('2026-02-25T00:00:00.000Z'),
};

describe('createValidateMilestoneHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when request is unauthenticated', async () => {
    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: undefined });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockVerifierAssignmentRepository.isVerifierAssignedToVault).not.toHaveBeenCalled();
  });

  it('returns 403 when authenticated user is not a verifier', async () => {
    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: 'issuer-1', role: 'issuer' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockVerifierAssignmentRepository.isVerifierAssignedToVault).not.toHaveBeenCalled();
  });

  it('returns 403 when verifier is not assigned to the vault', async () => {
    mockVerifierAssignmentRepository.isVerifierAssignedToVault.mockResolvedValueOnce(false);

    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: 'verifier-1', role: 'verifier' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockVerifierAssignmentRepository.isVerifierAssignedToVault).toHaveBeenCalledWith(
      'vault-1',
      'verifier-1'
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('returns 404 when milestone does not exist', async () => {
    mockVerifierAssignmentRepository.isVerifierAssignedToVault.mockResolvedValueOnce(true);
    mockMilestoneRepository.getByVaultAndId.mockResolvedValueOnce(null);

    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: 'verifier-1', role: 'verifier' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Milestone not found' });
  });

  it('returns 409 when milestone is already validated', async () => {
    mockVerifierAssignmentRepository.isVerifierAssignedToVault.mockResolvedValueOnce(true);
    mockMilestoneRepository.getByVaultAndId.mockResolvedValueOnce({
      ...pendingMilestone,
      status: 'validated',
      validated_at: new Date('2026-02-24T00:00:00.000Z'),
      validated_by: 'verifier-2',
    });

    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: 'verifier-1', role: 'verifier' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Milestone already validated' });
    expect(mockValidationEventRepository.create).not.toHaveBeenCalled();
    expect(mockMilestoneRepository.markValidated).not.toHaveBeenCalled();
    expect(mockDomainEventPublisher.publish).not.toHaveBeenCalled();
  });

  it('persists validation event, updates milestone, and emits domain event', async () => {
    mockVerifierAssignmentRepository.isVerifierAssignedToVault.mockResolvedValueOnce(true);
    mockMilestoneRepository.getByVaultAndId.mockResolvedValueOnce(pendingMilestone);
    mockValidationEventRepository.create.mockResolvedValueOnce(validationEvent);
    mockMilestoneRepository.markValidated.mockResolvedValueOnce({
      ...pendingMilestone,
      status: 'validated',
      validated_by: 'verifier-1',
      validated_at: new Date('2026-02-25T00:00:00.000Z'),
    });

    const handler = createValidateMilestoneHandler({
      milestoneRepository: mockMilestoneRepository,
      verifierAssignmentRepository: mockVerifierAssignmentRepository,
      milestoneValidationEventRepository: mockValidationEventRepository,
      domainEventPublisher: mockDomainEventPublisher,
    });
    const req = createRequest({ userId: 'verifier-1', role: 'verifier' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockValidationEventRepository.create).toHaveBeenCalledWith({
      vaultId: 'vault-1',
      milestoneId: 'milestone-1',
      verifierId: 'verifier-1',
      createdAt: expect.any(Date),
    });
    expect(mockMilestoneRepository.markValidated).toHaveBeenCalledWith({
      vaultId: 'vault-1',
      milestoneId: 'milestone-1',
      verifierId: 'verifier-1',
      validatedAt: expect.any(Date),
    });
    expect(mockDomainEventPublisher.publish).toHaveBeenCalledWith(
      'vault.milestone.validated',
      {
        validationEventId: 'validation-event-1',
        vaultId: 'vault-1',
        milestoneId: 'milestone-1',
        verifierId: 'verifier-1',
        validatedAt: expect.any(String),
      }
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: {
        milestone: {
          ...pendingMilestone,
          status: 'validated',
          validated_by: 'verifier-1',
          validated_at: new Date('2026-02-25T00:00:00.000Z'),
        },
        validationEvent,
      },
    });
  });
});
