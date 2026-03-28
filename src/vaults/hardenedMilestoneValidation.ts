/**
 * Hardened Milestone Validation Handler with production-grade security
 * 
 * Integrates authentication, authorization, validation, rate limiting,
 * and comprehensive audit logging for secure milestone validation.
 */

import { Request, Response, NextFunction, Router } from 'express';
import {
  SecurityContext,
  SecurityAuditRepository,
  SecurityConfig,
  DEFAULT_SECURITY_CONFIG,
  ValidationError,
  AuthorizationError,
} from '../security/types';
import {
  recordAuditEvent,
  createAuthenticationMiddleware,
  createAuthorizationMiddleware,
} from '../security/auth';
import {
  validateMilestoneValidationParams,
  validateVerifierRole,
  ValidationLimiter,
  InMemoryValidationLimiter,
  createValidationLimiterMiddleware,
} from '../security/validation';
import {
  createRateLimitMiddleware,
  createRateLimitStore,
  createValidationRateLimit,
} from '../security/rateLimit';

// Import existing milestone interfaces
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

/**
 * Hardened milestone validation dependencies
 */
export interface HardenedMilestoneValidationDeps {
  milestoneRepository: MilestoneRepository;
  verifierAssignmentRepository: VerifierAssignmentRepository;
  milestoneValidationEventRepository: MilestoneValidationEventRepository;
  domainEventPublisher: DomainEventPublisher;
  auditRepository: SecurityAuditRepository;
  validationLimiter?: ValidationLimiter;
  securityConfig?: SecurityConfig;
}

/**
 * Validates that a milestone can be validated (business logic validation)
 */
export const validateMilestoneBusinessRules = async (
  milestone: Milestone | null | undefined,
  vaultId: string,
  milestoneId: string,
  verifierId: string,
  verifierAssignmentRepository: VerifierAssignmentRepository
): Promise<void> => {
  if (!milestone) {
    throw new ValidationError('Milestone not found', {
      vaultId,
      milestoneId,
    });
  }

  if (milestone.status === 'validated') {
    throw new ValidationError('Milestone already validated', {
      vaultId,
      milestoneId,
      currentStatus: milestone.status,
      validatedAt: milestone.validated_at,
      validatedBy: milestone.validated_by,
    });
  }

  // Check if verifier is assigned to this vault
  const isAssigned = await verifierAssignmentRepository.isVerifierAssignedToVault(
    vaultId,
    verifierId
  );

  if (!isAssigned) {
    throw new AuthorizationError('Verifier not assigned to vault', {
      vaultId,
      verifierId,
    });
  }
};

/**
 * Executes milestone validation with transaction-like semantics
 */
export const executeMilestoneValidation = async (
  vaultId: string,
  milestoneId: string,
  verifierId: string,
  securityContext: SecurityContext,
  deps: HardenedMilestoneValidationDeps
): Promise<{ milestone: Milestone; validationEvent: MilestoneValidationEvent }> => {
  const now = new Date();
  const startTime = Date.now();

  try {
    // Create validation event first (for audit trail)
    const validationEvent = await deps.milestoneValidationEventRepository.create({
      vaultId,
      milestoneId,
      verifierId,
      createdAt: now,
    });

    // Update milestone status
    const updatedMilestone = await deps.milestoneRepository.markValidated({
      vaultId,
      milestoneId,
      verifierId,
      validatedAt: now,
    });

    // Publish domain event
    await deps.domainEventPublisher.publish('vault.milestone.validated', {
      validationEventId: validationEvent.id,
      vaultId,
      milestoneId,
      verifierId,
      validatedAt: now.toISOString(),
      requestId: securityContext.requestId,
    });

    // Record successful validation
    await recordAuditEvent(
      deps.auditRepository,
      'VALIDATION',
      'milestone_validated',
      `vault:${vaultId}:milestone:${milestoneId}`,
      'SUCCESS',
      securityContext,
      {
        validationEventId: validationEvent.id,
        validationTime: Date.now() - startTime,
        milestoneStatus: updatedMilestone.status,
      }
    );

    return {
      milestone: updatedMilestone,
      validationEvent,
    };
  } catch (error) {
    // Record failed validation
    await recordAuditEvent(
      deps.auditRepository,
      'VALIDATION',
      'milestone_validation_failed',
      `vault:${vaultId}:milestone:${milestoneId}`,
      'FAILURE',
      securityContext,
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        validationTime: Date.now() - startTime,
      }
    );

    throw error;
  }
};

/**
 * Hardened milestone validation handler with comprehensive security
 */
export const createHardenedMilestoneValidationHandler = (
  deps: HardenedMilestoneValidationDeps
) => {
  const config = deps.securityConfig || DEFAULT_SECURITY_CONFIG;
  const rateLimitStore = createRateLimitStore();
  const validationLimiter = deps.validationLimiter || new InMemoryValidationLimiter(
    config.maxConcurrentValidations
  );

  return [
    // Rate limiting (applied before auth to prevent DoS)
    createValidationRateLimit(rateLimitStore, deps.auditRepository),
    
    // Authentication middleware
    createAuthenticationMiddleware({
      auditRepository: deps.auditRepository,
      config,
    }),
    
    // Authorization middleware - require milestone validation permission
    createAuthorizationMiddleware(['milestone:validate'], {
      auditRepository: deps.auditRepository,
      config,
    }),
    
    // Input validation middleware
    validateMilestoneValidationParams,
    
    // Concurrent validation limiting
    createValidationLimiterMiddleware(validationLimiter),
    
    // Main validation handler
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const securityContext = (req as any).securityContext as SecurityContext;
      const { id: vaultId, mid: milestoneId } = (req as any).validated?.params || {};

      try {
        // Validate verifier role
        validateVerifierRole(req, securityContext);

        // Get milestone for validation
        const milestone = await deps.milestoneRepository.getByVaultAndId(vaultId, milestoneId);

        // Validate business rules (function handles null milestone)
        await validateMilestoneBusinessRules(
          milestone,
          vaultId,
          milestoneId,
          securityContext.user.id,
          deps.verifierAssignmentRepository
        );

        // Execute validation
        const result = await executeMilestoneValidation(
          vaultId,
          milestoneId,
          securityContext.user.id,
          securityContext,
          deps
        );

        // Release validation limiter
        await validationLimiter.releaseValidation(vaultId, securityContext.user.id);

        res.status(200).json({
          data: {
            milestone: result.milestone,
            validationEvent: result.validationEvent,
          },
          meta: {
            requestId: securityContext.requestId,
            validatedAt: result.validationEvent.created_at.toISOString(),
          },
        });
      } catch (error) {
        // Release validation limiter on error
        if (vaultId && securityContext) {
          await validationLimiter.releaseValidation(vaultId, securityContext.user.id);
        }

        if (error instanceof ValidationError || error instanceof AuthorizationError) {
          res.status(error instanceof ValidationError ? 400 : 403).json({
            error: error.message,
            code: error.code,
            details: error.details,
            requestId: securityContext?.requestId,
          });
        } else {
          next(error);
        }
      }
    },
  ];
};

/**
 * Creates hardened milestone validation router
 */
export const createHardenedMilestoneValidationRouter = (
  deps: HardenedMilestoneValidationDeps
): Router => {
  const router = Router();
  const handlers = createHardenedMilestoneValidationHandler(deps);

  // Apply all middleware chain
  router.post('/vaults/:id/milestones/:mid/validate', ...handlers);

  return router;
};

/**
 * Security monitoring endpoint for audit trail
 */
export const createSecurityMonitoringRouter = (
  auditRepository: SecurityAuditRepository,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): Router => {
  const router = Router();
  const rateLimitStore = createRateLimitStore();

  // Apply authentication and authorization for audit access
  router.use(
    createAuthenticationMiddleware({ auditRepository, config }),
    createAuthorizationMiddleware(['audit:read'], { auditRepository, config }),
    createRateLimitMiddleware({
      config: config.rateLimits.audit,
      store: rateLimitStore,
      auditRepository,
    })
  );

  // Get user's audit trail
  router.get('/security/audit/my-events', async (req: Request, res: Response) => {
    const securityContext = (req as any).securityContext as SecurityContext;
    const limit = parseInt(req.query.limit as string) || 100;

    try {
      const events = await auditRepository.findByUserId(securityContext.user.id, limit);
      
      res.json({
        data: events,
        meta: {
          count: events.length,
          userId: securityContext.user.id,
          requestId: securityContext.requestId,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve audit events',
        requestId: securityContext.requestId,
      });
    }
  });

  // Get security violations (admin only)
  router.get('/security/violations', async (req: Request, res: Response) => {
    const securityContext = (req as any).securityContext as SecurityContext;
    
    if (securityContext.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required',
        requestId: securityContext.requestId,
      });
    }

    const since = req.query.since 
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours
    const limit = parseInt(req.query.limit as string) || 100;

    try {
      const violations = await auditRepository.findSecurityViolations(since, limit);
      
      res.json({
        data: violations,
        meta: {
          count: violations.length,
          since: since.toISOString(),
          requestId: securityContext.requestId,
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to retrieve security violations',
        requestId: securityContext.requestId,
      });
    }
  });

  return router;
};
