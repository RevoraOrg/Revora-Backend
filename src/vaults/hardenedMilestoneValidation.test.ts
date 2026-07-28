/**
 * Comprehensive test suite for the hardened milestone validation auth matrix
 * 
 * Tests all security layers: authentication, authorization, validation,
 * rate limiting, audit logging, and business logic with deterministic scenarios.
 */

import { Request, Response } from 'express';
import {
  createHardenedMilestoneValidationHandler,
  createHardenedMilestoneValidationRouter,
  createSecurityMonitoringRouter,
  validateMilestoneBusinessRules,
  executeMilestoneValidation,
} from './hardenedMilestoneValidation';
import {
  InMemorySecurityAuditRepository,
  createSecurityAuditRepository,
} from '../security/audit';
import {
  InMemoryRateLimitStore,
  createRateLimitStore,
} from '../security/rateLimit';
import {
  AuthenticatedUser,
  SecurityContext,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  AppError,
  DEFAULT_SECURITY_CONFIG,
} from '../security/types';
import {
  InMemoryValidationLimiter,
  ValidationLimiter,
} from '../security/validation';

// Mock implementations
const createMockVaultRepository = () => ({
  getById: jest.fn(),
});

const createMockMilestoneRepository = () => ({
  getByVaultAndId: jest.fn(),
  listByVault: jest.fn(),
  markValidated: jest.fn(),
});

const createMockValidationLimiter = (): jest.Mocked<ValidationLimiter> => ({
  checkConcurrentValidations: jest.fn(),
  releaseValidation: jest.fn(),
});

const createMockVerifierAssignmentRepository = () => ({
  isVerifierAssignedToVault: jest.fn(),
});

const createMockValidationEventRepository = () => ({
  create: jest.fn(),
});

const createMockDomainEventPublisher = () => ({
  publish: jest.fn(),
});

const createMockResponse = (): Response => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
};

const createMockNext = (): jest.Mock => jest.fn();

const createMockSecurityContext = (
  overrides: Partial<AuthenticatedUser> = {}
): SecurityContext => ({
  user: {
    id: 'verifier-1',
    role: 'verifier',
    permissions: ['milestone:validate'],
    sessionId: 'session-1',
    authenticatedAt: new Date(),
    ...overrides,
  },
  requestId: 'req-1',
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
  timestamp: new Date(),
});

const createMockRequest = (
  overrides: Partial<Request> & {
    securityContext?: SecurityContext;
    validated?: { params: Record<string, string> };
  } = {}
): Request => {
  const req = {
    params: { id: 'vault-1', mid: 'milestone-1' },
    query: {},
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test-agent' },
    ...overrides,
  } as unknown as Request;

  if (overrides.securityContext) {
    (req as any).securityContext = overrides.securityContext;
  }

  if (overrides.validated) {
    (req as any).validated = overrides.validated;
  }

  return req;
};

describe('Hardened Milestone Validation Auth Matrix', () => {
  let auditRepository: InMemorySecurityAuditRepository;
  let rateLimitStore: InMemoryRateLimitStore;
  let validationLimiter: jest.Mocked<ValidationLimiter>;
  let milestoneRepo: any;
  let vaultRepo: any;
  let verifierAssignmentRepo: any;
  let validationEventRepo: any;
  let domainEventPublisher: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    auditRepository = new InMemorySecurityAuditRepository();
    rateLimitStore = new InMemoryRateLimitStore();
    validationLimiter = createMockValidationLimiter();
    
    milestoneRepo = createMockMilestoneRepository();
    vaultRepo = createMockVaultRepository();
    verifierAssignmentRepo = createMockVerifierAssignmentRepository();
    validationEventRepo = createMockValidationEventRepository();
    domainEventPublisher = createMockDomainEventPublisher();
  });

  const makeDeps = () => ({
    milestoneRepository: milestoneRepo,
    vaultRepository: vaultRepo,
    verifierAssignmentRepository: verifierAssignmentRepo,
    milestoneValidationEventRepository: validationEventRepo,
    domainEventPublisher,
    auditRepository,
    validationLimiter,
    securityConfig: DEFAULT_SECURITY_CONFIG,
  });

  describe('validateMilestoneBusinessRules', () => {
    beforeEach(() => {
      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
    });

    it('throws AppError when milestone is null', async () => {
      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      milestoneRepo.getByVaultAndId.mockResolvedValue(null);

      await expect(
        validateMilestoneBusinessRules(
          null,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when milestone is already validated', async () => {
      const validatedMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'validated' as const,
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });

      await expect(
        validateMilestoneBusinessRules(
          validatedMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when verifier is the same as the one who created the milestone (simplified check)', async () => {
      // Assuming business rule: verifier cannot be the same as some other role
      // This is a placeholder for actual business logic
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
        created_by: 'verifier-1',
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when vault is not found', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      vaultRepo.getById.mockResolvedValue(null);

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when vault is not active', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'closed' });

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when verifier is not assigned to vault', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
        sequence: 1,
        created_at: new Date(),
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      milestoneRepo.listByVault.mockResolvedValue([pendingMilestone]);
      verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(false);

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when milestone is not found in vault list', async () => {
      const milestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
        created_at: new Date(),
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      // Return empty list so milestone is not found
      milestoneRepo.listByVault.mockResolvedValue([]);

      await expect(
        validateMilestoneBusinessRules(
          milestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when previous milestone is not validated', async () => {
      const now = new Date();
      const milestone1 = { 
        id: 'milestone-1', 
        vault_id: 'vault-1', 
        status: 'pending' as const, 
        sequence: 1,
        created_at: new Date(now.getTime() - 1000)
      };
      const milestone2 = {
        id: 'milestone-2',
        vault_id: 'vault-1',
        status: 'pending' as const,
        sequence: 2,
        created_at: now
      };

      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      milestoneRepo.listByVault.mockResolvedValue([milestone1, milestone2]);

      await expect(
        validateMilestoneBusinessRules(
          milestone2,
          'vault-1',
          'milestone-2',
          'verifier-1',
          makeDeps()
        )
      ).rejects.toThrow(AppError);
    });
  });

  describe('executeMilestoneValidation', () => {
    const securityContext = createMockSecurityContext();
    const makeDeps = () => ({
      milestoneRepository: milestoneRepo,
      vaultRepository: vaultRepo,
      verifierAssignmentRepository: verifierAssignmentRepo,
      milestoneValidationEventRepository: validationEventRepo,
      domainEventPublisher,
      auditRepository,
    });

    it('successfully validates milestone and records all events', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      const validationEvent = {
        id: 'event-1',
        vault_id: 'vault-1',
        milestone_id: 'milestone-1',
        verifier_id: 'verifier-1',
        created_at: new Date(),
      };

      const updatedMilestone = {
        ...pendingMilestone,
        status: 'validated' as const,
        validated_at: new Date(),
        validated_by: 'verifier-1',
      };

      validationEventRepo.create.mockResolvedValue(validationEvent);
      milestoneRepo.markValidated.mockResolvedValue(updatedMilestone);
      domainEventPublisher.publish.mockResolvedValue(undefined);

      const result = await executeMilestoneValidation(
        'vault-1',
        'milestone-1',
        'verifier-1',
        securityContext,
        makeDeps()
      );

      expect(result).toEqual({
        milestone: updatedMilestone,
        validationEvent,
      });

      expect(validationEventRepo.create).toHaveBeenCalledWith({
        vaultId: 'vault-1',
        milestoneId: 'milestone-1',
        verifierId: 'verifier-1',
        createdAt: expect.any(Date),
      });

      expect(milestoneRepo.markValidated).toHaveBeenCalledWith({
        vaultId: 'vault-1',
        milestoneId: 'milestone-1',
        verifierId: 'verifier-1',
        validatedAt: expect.any(Date),
      });

      expect(domainEventPublisher.publish).toHaveBeenCalledWith(
        'vault.milestone.validated',
        expect.objectContaining({
          vaultId: 'vault-1',
          milestoneId: 'milestone-1',
          verifierId: 'verifier-1',
        })
      );

      // Check audit events
      const auditEvents = auditRepository.getAllEvents();
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].type).toBe('VALIDATION');
      expect(auditEvents[0].action).toBe('milestone_validated');
      expect(auditEvents[0].outcome).toBe('SUCCESS');
    });

    it('records failure when validation fails', async () => {
      const error = new Error('Database error');
      validationEventRepo.create.mockRejectedValue(error);

      await expect(
        executeMilestoneValidation(
          'vault-1',
          'milestone-1',
          'verifier-1',
          securityContext,
          makeDeps()
        )
      ).rejects.toThrow('Database error');

      // Check audit events
      const auditEvents = auditRepository.getAllEvents();
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0].type).toBe('VALIDATION');
      expect(auditEvents[0].action).toBe('milestone_validation_failed');
      expect(auditEvents[0].outcome).toBe('FAILURE');
      expect(auditEvents[0].details.error).toBe('Database error');
    });
  });

  describe('Hardened Milestone Validation Handler', () => {
    const makeDeps = () => ({
      milestoneRepository: milestoneRepo,
      vaultRepository: vaultRepo,
      verifierAssignmentRepository: verifierAssignmentRepo,
      milestoneValidationEventRepository: validationEventRepo,
      domainEventPublisher,
      auditRepository,
      validationLimiter,
      securityConfig: DEFAULT_SECURITY_CONFIG,
    });

    it('handles successful validation flow', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      const validationEvent = {
        id: 'event-1',
        vault_id: 'vault-1',
        milestone_id: 'milestone-1',
        verifier_id: 'verifier-1',
        created_at: new Date(),
      };

      const updatedMilestone = {
        ...pendingMilestone,
        status: 'validated' as const,
        validated_at: new Date(),
        validated_by: 'verifier-1',
      };

      // Mock all dependencies
      verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(true);
      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      milestoneRepo.getByVaultAndId.mockResolvedValue(pendingMilestone);
      milestoneRepo.listByVault.mockResolvedValue([
        { id: 'milestone-1', vault_id: 'vault-1', status: 'pending', sequence: 1 }
      ]);
      validationEventRepo.create.mockResolvedValue(validationEvent);
      milestoneRepo.markValidated.mockResolvedValue(updatedMilestone);
      domainEventPublisher.publish.mockResolvedValue(undefined);
      validationLimiter.checkConcurrentValidations.mockResolvedValue(true);
      validationLimiter.releaseValidation.mockResolvedValue(undefined);

      const handlers = createHardenedMilestoneValidationHandler(makeDeps());
      const mainHandler = handlers[handlers.length - 1]; // Get the main handler

      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await mainHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            milestone: updatedMilestone,
            validationEvent,
          },
          meta: expect.objectContaining({
            requestId: 'req-1',
          }),
        })
      );

      // The main handler is invoked directly here (without middleware chain),
      // so only releaseValidation is expected.
      expect(validationLimiter.releaseValidation).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
    });

    it('handles concurrent validation limit exceeded', async () => {
      validationLimiter.checkConcurrentValidations.mockResolvedValue(false);

      const handlers = createHardenedMilestoneValidationHandler(makeDeps());
      const rateLimitHandler = handlers[4]; // Validation limiter middleware

      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await rateLimitHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too many concurrent validations for this vault',
        })
      );
    });

    it('handles business rule validation failures', async () => {
      const handlers = createHardenedMilestoneValidationHandler(makeDeps());
      const mainHandler = handlers[handlers.length - 1];

      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = createMockNext();

      // Mock dependencies for business rule validation
      vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
      milestoneRepo.getByVaultAndId.mockResolvedValue(null);
      validationLimiter.checkConcurrentValidations.mockResolvedValue(true);
      validationLimiter.releaseValidation.mockResolvedValue(undefined);

      await mainHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Milestone not found',
        })
      );

      // Verify limiter was released even on error
      expect(validationLimiter.releaseValidation).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
    });
  });

  describe('Hardened Milestone Validation Auth Matrix', () => {
    describe('Rate Limiting Integration', () => {
      it('blocks requests when rate limit is exceeded', async () => {
        const handlers = createHardenedMilestoneValidationHandler(makeDeps());
        const rateLimitHandler = handlers[0]; // Rate limiting middleware

        const next = jest.fn();

        // Drive the middleware past the configured limit.
        let res = createMockResponse();
        for (let i = 0; i < 11; i++) {
          await rateLimitHandler(
            createMockRequest({ securityContext: createMockSecurityContext() }),
            createMockResponse(),
            next
          );
        }
        res = createMockResponse();
        await rateLimitHandler(
          createMockRequest({ securityContext: createMockSecurityContext() }),
          res,
          next
        );

        expect(res.status).toHaveBeenCalledWith(429);
      });
    });

    describe('Comprehensive Security Flow Integration', () => {
      it('maintains audit trail across all security layers', async () => {
        const deps = makeDeps();

        // Setup successful validation scenario
        const pendingMilestone = {
          id: 'milestone-1',
          vault_id: 'vault-1',
          status: 'pending' as const,
          sequence: 1,
          created_at: new Date(),
        };

        const validationEvent = {
          id: 'event-1',
          vault_id: 'vault-1',
          milestone_id: 'milestone-1',
          verifier_id: 'verifier-1',
          created_at: new Date(),
        };

        vaultRepo.getById.mockResolvedValue({ id: 'vault-1', status: 'active' });
        milestoneRepo.getByVaultAndId.mockResolvedValue(pendingMilestone);
        milestoneRepo.listByVault.mockResolvedValue([pendingMilestone]);
        verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(true);
        validationEventRepo.create.mockResolvedValue(validationEvent);
        milestoneRepo.markValidated.mockResolvedValue({ ...pendingMilestone, status: 'validated' });
        validationLimiter.checkConcurrentValidations.mockResolvedValue(true);

        const handlers = createHardenedMilestoneValidationHandler(deps);
        let currentIndex = 0;
        
        // Create request with necessary auth for authentication middleware
        const req = createMockRequest({
          securityContext: createMockSecurityContext(),
          validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
        });
        (req as any).auth = {
          userId: 'verifier-1',
          role: 'verifier',
          sessionId: 'session-1',
        };
        
        const res = createMockResponse();
        let nextCalled = true;
        const next = jest.fn().mockImplementation(() => { nextCalled = true; });

        // Execute each middleware in sequence, following next() calls
        while (currentIndex < handlers.length && nextCalled) {
          nextCalled = false;
          await handlers[currentIndex](req, res, next);
          currentIndex++;
        }

        expect(res.status).toHaveBeenCalledWith(200);

        // Should have events for: auth, authorization, validation
        const auditEvents = auditRepository.getAllEvents();
        expect(auditEvents.length).toBeGreaterThanOrEqual(3);

        const eventTypes = auditEvents.map(e => e.type);
        expect(eventTypes).toContain('AUTHENTICATION');
        expect(eventTypes).toContain('AUTHORIZATION');
        expect(eventTypes).toContain('VALIDATION');
      });
    });
  });

  describe('Security Monitoring Router', () => {
    it('returns user audit events', async () => {
      const router = createSecurityMonitoringRouter(auditRepository);
      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        query: { limit: '10' },
      });
      const res = createMockResponse();
      
      // Get the GET handler for /security/audit/my-events
      // In a real app we'd use supertest, but here we can find it in the router
      const handler = (router as any).stack.find((s: any) => s.route?.path === '/security/audit/my-events')?.route.stack[0].handle;
      
      await handler(req, res);
      
      expect(res.json).toHaveBeenCalled();
      const responseData = res.json.mock.calls[0][0];
      expect(responseData.meta.userId).toBe('verifier-1');
    });

    it('handles error when retrieving audit events', async () => {
      const failingAuditRepo = {
        findByUserId: jest.fn().mockRejectedValue(new Error('Database error')),
      } as any;
      const router = createSecurityMonitoringRouter(failingAuditRepo);
      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
      });
      const res = createMockResponse();
      
      const handler = (router as any).stack.find((s: any) => s.route?.path === '/security/audit/my-events')?.route.stack[0].handle;
      
      await handler(req, res);
      
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('denies access to security violations for non-admins', async () => {
      const router = createSecurityMonitoringRouter(auditRepository);
      const req = createMockRequest({
        securityContext: createMockSecurityContext(), // role: verifier
      });
      const res = createMockResponse();
      
      const handler = (router as any).stack.find((s: any) => s.route?.path === '/security/violations')?.route.stack[0].handle;
      
      await handler(req, res);
      
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns security violations for admins', async () => {
      const router = createSecurityMonitoringRouter(auditRepository);
      const req = createMockRequest({
        securityContext: {
          ...createMockSecurityContext(),
          user: { id: 'admin-1', role: 'admin', permissions: ['audit:read'] },
        },
      });
      const res = createMockResponse();
      
      const handler = (router as any).stack.find((s: any) => s.route?.path === '/security/violations')?.route.stack[0].handle;
      
      await handler(req, res);
      
      expect(res.json).toHaveBeenCalled();
    });

    it('handles error when retrieving security violations', async () => {
      const failingAuditRepo = {
        findSecurityViolations: jest.fn().mockRejectedValue(new Error('Database error')),
      } as any;
      const router = createSecurityMonitoringRouter(failingAuditRepo);
      const req = createMockRequest({
        securityContext: {
          ...createMockSecurityContext(),
          user: { id: 'admin-1', role: 'admin', permissions: ['audit:read'] },
        },
      });
      const res = createMockResponse();
      
      const handler = (router as any).stack.find((s: any) => s.route?.path === '/security/violations')?.route.stack[0].handle;
      
      await handler(req, res);
      
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('Milestone Validation Router', () => {
    it('creates router with all handlers', () => {
      const router = createHardenedMilestoneValidationRouter(makeDeps());
      expect(router).toBeDefined();
      expect((router as any).stack.length).toBeGreaterThan(0);
    });
  });

  describe('Unhandled Errors', () => {
    it('handles unhandled errors in main handler', async () => {
      const deps = makeDeps();
      const handlers = createHardenedMilestoneValidationHandler(deps);
      const mainHandler = handlers[handlers.length - 1];
      
      // Force an unexpected error by mocking milestoneRepository.getByVaultAndId to throw
      milestoneRepo.getByVaultAndId.mockRejectedValue(new Error('Unexpected database error'));
      
      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = jest.fn();
      
      await mainHandler(req, res, next);
      
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
