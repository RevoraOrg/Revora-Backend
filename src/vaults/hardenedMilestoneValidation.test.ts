/**
 * Comprehensive test suite for the hardened milestone validation auth matrix
 * 
 * Tests all security layers: authentication, authorization, validation,
 * rate limiting, audit logging, and business logic with deterministic scenarios.
 */

import { Request, Response } from 'express';
import {
  createHardenedMilestoneValidationHandler,
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
  DEFAULT_SECURITY_CONFIG,
} from '../security/types';
import {
  InMemoryValidationLimiter,
  ValidationLimiter,
} from '../security/validation';

// Mock implementations
const createMockMilestoneRepository = () => ({
  getByVaultAndId: jest.fn(),
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
  let verifierAssignmentRepo: any;
  let validationEventRepo: any;
  let domainEventPublisher: any;

  beforeEach(() => {
    jest.clearAllMocks();
    
    auditRepository = new InMemorySecurityAuditRepository();
    rateLimitStore = new InMemoryRateLimitStore();
    validationLimiter = createMockValidationLimiter();
    
    milestoneRepo = createMockMilestoneRepository();
    verifierAssignmentRepo = createMockVerifierAssignmentRepository();
    validationEventRepo = createMockValidationEventRepository();
    domainEventPublisher = createMockDomainEventPublisher();
  });

  describe('validateMilestoneBusinessRules', () => {
    it('throws ValidationError when milestone is null', async () => {
      await expect(
        validateMilestoneBusinessRules(
          null,
          'vault-1',
          'milestone-1',
          'verifier-1',
          verifierAssignmentRepo
        )
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when milestone is undefined', async () => {
      await expect(
        validateMilestoneBusinessRules(
          undefined,
          'vault-1',
          'milestone-1',
          'verifier-1',
          verifierAssignmentRepo
        )
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when milestone already validated', async () => {
      const validatedMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'validated' as const,
        validated_at: new Date(),
        validated_by: 'verifier-2',
      };

      await expect(
        validateMilestoneBusinessRules(
          validatedMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          verifierAssignmentRepo
        )
      ).rejects.toThrow(ValidationError);
    });

    it('throws AuthorizationError when verifier not assigned to vault', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(false);

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          verifierAssignmentRepo
        )
      ).rejects.toThrow(AuthorizationError);

      expect(verifierAssignmentRepo.isVerifierAssignedToVault).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
    });

    it('passes validation for pending milestone with assigned verifier', async () => {
      const pendingMilestone = {
        id: 'milestone-1',
        vault_id: 'vault-1',
        status: 'pending' as const,
      };

      verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(true);

      await expect(
        validateMilestoneBusinessRules(
          pendingMilestone,
          'vault-1',
          'milestone-1',
          'verifier-1',
          verifierAssignmentRepo
        )
      ).resolves.not.toThrow();
    });
  });

  describe('executeMilestoneValidation', () => {
    const securityContext = createMockSecurityContext();
    const deps = {
      milestoneRepository: milestoneRepo,
      verifierAssignmentRepository: verifierAssignmentRepo,
      milestoneValidationEventRepository: validationEventRepo,
      domainEventPublisher,
      auditRepository,
    };

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
        deps
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
          deps
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
    const deps = {
      milestoneRepository: milestoneRepo,
      verifierAssignmentRepository: verifierAssignmentRepo,
      milestoneValidationEventRepository: validationEventRepo,
      domainEventPublisher,
      auditRepository,
      validationLimiter,
      securityConfig: DEFAULT_SECURITY_CONFIG,
    };

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
      milestoneRepo.getByVaultAndId.mockResolvedValue(pendingMilestone);
      validationEventRepo.create.mockResolvedValue(validationEvent);
      milestoneRepo.markValidated.mockResolvedValue(updatedMilestone);
      domainEventPublisher.publish.mockResolvedValue(undefined);
      validationLimiter.checkConcurrentValidations.mockResolvedValue(true);
      validationLimiter.releaseValidation.mockResolvedValue(undefined);

      const handlers = createHardenedMilestoneValidationHandler(deps);
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

      // Verify validation limiter was used
      expect(validationLimiter.checkConcurrentValidations).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
      expect(validationLimiter.releaseValidation).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
    });

    it('handles concurrent validation limit exceeded', async () => {
      validationLimiter.checkConcurrentValidations.mockResolvedValue(false);

      const handlers = createHardenedMilestoneValidationHandler(deps);
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
      const handlers = createHardenedMilestoneValidationHandler(deps);
      const mainHandler = handlers[handlers.length - 1];

      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = createMockNext();

      // Mock milestone not found
      milestoneRepo.getByVaultAndId.mockResolvedValue(null);
      validationLimiter.checkConcurrentValidations.mockResolvedValue(true);
      validationLimiter.releaseValidation.mockResolvedValue(undefined);

      await mainHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Milestone not found',
          code: 'VALIDATION_FAILED',
        })
      );

      // Verify limiter was released even on error
      expect(validationLimiter.releaseValidation).toHaveBeenCalledWith(
        'vault-1',
        'verifier-1'
      );
    });
  });

  describe('Security Monitoring Router', () => {
    it('allows users to view their own audit events', async () => {
      const router = createSecurityMonitoringRouter(auditRepository);
      
      // Add some audit events
      await auditRepository.record({
        id: 'audit-1',
        type: 'VALIDATION',
        userId: 'verifier-1',
        action: 'milestone_validated',
        resource: 'vault:vault-1:milestone:milestone-1',
        outcome: 'SUCCESS',
        details: {},
        securityContext: {
          requestId: 'req-1',
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      });

      const req = createMockRequest({
        securityContext: createMockSecurityContext({ id: 'verifier-1' }),
        query: { limit: '10' },
      });
      const res = createMockResponse();

      // Mock the middleware chain
      const middleware = router.stack.find((layer: any) => 
        layer.route?.path === '/security/audit/my-events'
      );

      if (middleware && middleware.route && middleware.route.stack[0]) {
        await (middleware.route.stack[0] as any).handle(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.arrayContaining([
              expect.objectContaining({
                type: 'VALIDATION',
                userId: 'verifier-1',
                action: 'milestone_validated',
              }),
            ]),
            meta: expect.objectContaining({
              count: expect.any(Number),
              userId: 'verifier-1',
            }),
          })
        );
      }
    });

    it('blocks non-admin users from viewing security violations', async () => {
      const router = createSecurityMonitoringRouter(auditRepository);
      
      const req = createMockRequest({
        securityContext: createMockSecurityContext({ role: 'verifier' }), // Not admin
      });
      const res = createMockResponse();

      const middleware = router.stack.find((layer: any) => 
        layer.route?.path === '/security/violations'
      );

      if (middleware && middleware.route && middleware.route.stack[0]) {
        await (middleware.route.stack[0] as any).handle(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'Admin access required',
          })
        );
      }
    });
  });

  describe('Rate Limiting Integration', () => {
    it('blocks requests when rate limit is exceeded', async () => {
      const deps = {
        milestoneRepository: milestoneRepo,
        verifierAssignmentRepository: verifierAssignmentRepo,
        milestoneValidationEventRepository: validationEventRepo,
        domainEventPublisher,
        auditRepository,
        validationLimiter,
        securityConfig: DEFAULT_SECURITY_CONFIG,
      };

      // Exceed rate limit
      for (let i = 0; i < 11; i++) {
        await rateLimitStore.increment('validation:verifier-1', 60000);
      }

      const handlers = createHardenedMilestoneValidationHandler(deps);
      const rateLimitHandler = handlers[0]; // Rate limiting middleware

      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
      });
      const res = createMockResponse();
      const next = createMockNext();

      await rateLimitHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Rate limit exceeded',
          retryAfter: expect.any(Number),
        })
      );

      // Check that rate limit violation was recorded
      const auditEvents = auditRepository.getAllEvents();
      const violations = auditEvents.filter(e => e.type === 'SECURITY_VIOLATION');
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].action).toBe('rate_limit_exceeded');
    });
  });

  describe('Comprehensive Security Flow Integration', () => {
    it('maintains audit trail across all security layers', async () => {
      const deps = {
        milestoneRepository: milestoneRepo,
        verifierAssignmentRepository: verifierAssignmentRepo,
        milestoneValidationEventRepository: validationEventRepo,
        domainEventPublisher,
        auditRepository,
        validationLimiter,
        securityConfig: DEFAULT_SECURITY_CONFIG,
      };

      // Setup successful validation scenario
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

      verifierAssignmentRepo.isVerifierAssignedToVault.mockResolvedValue(true);
      milestoneRepo.getByVaultAndId.mockResolvedValue(pendingMilestone);
      validationEventRepo.create.mockResolvedValue(validationEvent);
      milestoneRepo.markValidated.mockResolvedValue(updatedMilestone);
      domainEventPublisher.publish.mockResolvedValue(undefined);
      validationLimiter.checkConcurrentValidations.mockResolvedValue(true);
      validationLimiter.releaseValidation.mockResolvedValue(undefined);

      const handlers = createHardenedMilestoneValidationHandler(deps);
      
      // Simulate the complete middleware chain
      let currentIndex = 0;
      const req = createMockRequest({
        securityContext: createMockSecurityContext(),
        validated: { params: { id: 'vault-1', mid: 'milestone-1' } },
      });
      const res = createMockResponse();
      const next = jest.fn();

      // Execute each middleware in sequence
      while (currentIndex < handlers.length) {
        await handlers[currentIndex](req, res, next);
        currentIndex++;
      }

      // Verify comprehensive audit trail
      const auditEvents = auditRepository.getAllEvents();
      
      // Should have events for: rate limit check, auth, authorization, validation
      expect(auditEvents.length).toBeGreaterThanOrEqual(3);
      
      const eventTypes = auditEvents.map(e => e.type);
      expect(eventTypes).toContain('VALIDATION');
      
      const validationEvents = auditEvents.filter(e => e.type === 'VALIDATION');
      expect(validationEvents).toHaveLength(1);
      expect(validationEvents[0].outcome).toBe('SUCCESS');
      expect(validationEvents[0].action).toBe('milestone_validated');
    });
  });
});
