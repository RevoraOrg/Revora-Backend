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
import { logger } from '../lib/logger';
import { Errors } from '../lib/errors';

// Import existing milestone interfaces
export type MilestoneStatus = 'pending' | 'validated';

export interface Milestone {
  id: string;
  vault_id: string;
  status: MilestoneStatus;
  created_at: Date; // Added for sequential validation
  validated_at?: Date;
  validated_by?: string;
}

export interface Vault {
  id: string;
  status: 'active' | 'closed' | 'paused';
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
  listByVault(vaultId: string): Promise<Milestone[]>; // Added for sequential validation
  markValidated(input: {
    vaultId: string;
    milestoneId: string;
    verifierId: string;
    validatedAt: Date;
  }): Promise<Milestone>;
}

export interface VaultRepository {
  getById(id: string): Promise<Vault | null>;
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
  vaultRepository: VaultRepository; // Added
  verifierAssignmentRepository: VerifierAssignmentRepository;
  milestoneValidationEventRepository: MilestoneValidationEventRepository;
  domainEventPublisher: DomainEventPublisher;
  auditRepository: SecurityAuditRepository;
  validationLimiter?: ValidationLimiter;
  securityConfig?: SecurityConfig;
}

/**
 * Validates vault invariants
 */
export const validateVaultInvariants = async (
  vaultId: string,
  vaultRepository: VaultRepository
): Promise<Vault> => {
  const vault = await vaultRepository.getById(vaultId);
  if (!vault) {
    logger.warn('Vault not found during validation', { vaultId });
    throw Errors.notFound('Vault not found');
  }

  if (vault.status !== 'active') {
    logger.warn('Attempted to validate milestone for non-active vault', {
      vaultId,
      vaultStatus: vault.status,
    });
    throw Errors.badRequest(`Vault is ${vault.status}, only active vaults can have milestones validated`);
  }

  return vault;
};

/**
 * Validates milestone invariants including sequential validation
 */
export const validateMilestoneInvariants = async (
  milestone: Milestone,
  milestoneRepository: MilestoneRepository
): Promise<void> => {
  // Check if milestone is already validated
  if (milestone.status === 'validated') {
    logger.warn('Milestone already validated', {
      vaultId: milestone.vault_id,
      milestoneId: milestone.id,
    });
    throw Errors.conflict('Milestone already validated');
  }

  // Check sequential validation: must be the first pending milestone
  const allMilestones = await milestoneRepository.listByVault(milestone.vault_id);
  const sortedMilestones = [...allMilestones].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime()
  );

  const pendingMilestones = sortedMilestones.filter((m) => m.status === 'pending');
  if (pendingMilestones.length === 0) {
    logger.error('No pending milestones found in vault', {
      vaultId: milestone.vault_id,
      milestoneId: milestone.id,
    });
    throw Errors.notFound('No pending milestones found in vault');
  }

  const firstPending = pendingMilestones[0];
  if (firstPending.id !== milestone.id) {
    logger.warn('Sequential validation invariant violated: not the first pending milestone', {
      vaultId: milestone.vault_id,
      milestoneId: milestone.id,
      expectedMilestoneId: firstPending.id,
    });
    throw Errors.badRequest(
      `Milestone ${firstPending.id} must be validated before ${milestone.id}`
    );
  }
};

/**
 * Validates that a milestone can be validated (business logic validation)
 */
export const validateMilestoneBusinessRules = async (
  milestone: Milestone | null | undefined,
  vaultId: string,
  milestoneId: string,
  verifierId: string,
  deps: Pick<HardenedMilestoneValidationDeps, 'milestoneRepository' | 'vaultRepository' | 'verifierAssignmentRepository'>
): Promise<void> => {
  // 1. Vault Invariants
  await validateVaultInvariants(vaultId, deps.vaultRepository);

  // 2. Milestone Existence
  if (!milestone) {
    logger.warn('Milestone not found', { vaultId, milestoneId });
    throw Errors.notFound('Milestone not found');
  }

  // 3. Milestone Invariants
  await validateMilestoneInvariants(milestone, deps.milestoneRepository);

  // 4. Verifier Authorization (Business Rule)
  const isAssigned = await deps.verifierAssignmentRepository.isVerifierAssignedToVault(
    vaultId,
    verifierId
  );

  if (!isAssigned) {
    logger.warn('Verifier not assigned to vault', { vaultId, verifierId });
    throw Errors.forbidden('Verifier not assigned to vault');
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

  logger.info('Starting milestone validation execution', {
    vaultId,
    milestoneId,
    verifierId,
    requestId: securityContext.requestId,
  });

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

    // Record successful validation in audit log
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

    logger.info('Milestone validation completed successfully', {
      vaultId,
      milestoneId,
      validationEventId: validationEvent.id,
      duration: Date.now() - startTime,
    });

    return {
      milestone: updatedMilestone,
      validationEvent,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    logger.error('Milestone validation execution failed', {
      vaultId,
      milestoneId,
      error: errorMessage,
      duration: Date.now() - startTime,
    });

    // Record failed validation in audit log
    await recordAuditEvent(
      deps.auditRepository,
      'VALIDATION',
      'milestone_validation_failed',
      `vault:${vaultId}:milestone:${milestoneId}`,
      'FAILURE',
      securityContext,
      {
        error: errorMessage,
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
          deps
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

        // Handle structured errors
        const isAppError = (err: any): err is any => 'statusCode' in err;
        const isSecurityError = (err: any): err is any => 'code' in err && 'details' in err;

        if (isAppError(error) || isSecurityError(error)) {
          const status = (error as any).statusCode || (error instanceof ValidationError ? 400 : 403);
          res.status(status).json({
            error: error instanceof Error ? error.message : 'Unknown error',
            code: (error as any).code || (error as any).name || 'INTERNAL_ERROR',
            details: (error as any).details,
            requestId: securityContext?.requestId,
          });
        } else {
          logger.error('Unhandled error in milestone validation', {
            error: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined,
            requestId: securityContext?.requestId,
          });
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
      logger.info('Retrieving user audit events', {
        userId: securityContext.user.id,
        limit,
        requestId: securityContext.requestId,
      });

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
      logger.error('Failed to retrieve audit events', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: securityContext.user.id,
        requestId: securityContext.requestId,
      });

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
      logger.warn('Unauthorized access attempt to security violations', {
        userId: securityContext.user.id,
        role: securityContext.user.role,
        requestId: securityContext.requestId,
      });

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
      logger.info('Retrieving security violations', {
        adminId: securityContext.user.id,
        since: since.toISOString(),
        limit,
        requestId: securityContext.requestId,
      });

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
      logger.error('Failed to retrieve security violations', {
        error: error instanceof Error ? error.message : 'Unknown error',
        adminId: securityContext.user.id,
        requestId: securityContext.requestId,
      });

      res.status(500).json({
        error: 'Failed to retrieve security violations',
        requestId: securityContext.requestId,
      });
    }
  });

  return router;
};
