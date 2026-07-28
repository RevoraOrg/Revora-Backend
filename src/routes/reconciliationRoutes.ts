/**
 * Revenue Reconciliation Routes
 * 
 * Exposes endpoints for revenue distribution reconciliation checks.
 * All routes require authentication and appropriate authorization.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Pool } from 'pg';
import { RevenueReconciliationService } from '../services/revenueReconciliationService';
import { AppError, Errors } from '../lib/errors';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Logger, LogLevel } from '../lib/logger';
import { classifyStellarRPCFailure, StellarRPCFailureClass } from '../lib/stellarRpcFailure';

export interface ReconciliationRequest extends Request {
  user?: {
    id: string;
    role: string;
    sessionToken: string;
  };
  requestId?: string;
}

export interface OfferingRepository {
  getById?: (id: string) => Promise<{ id: string; issuer_id?: string; issuer_user_id?: string } | null>;
  findById: (id: string) => Promise<{ id: string; issuer_id?: string; issuer_user_id?: string } | null>;
}

export function createReconciliationHandlers(
  reconciliationService: RevenueReconciliationService,
  offeringRepo?: OfferingRepository,
  auditLogRepo?: AuditLogRepository,
  logger?: Logger
) {
  /**
   * POST /api/reconciliation/reconcile
   * Perform comprehensive reconciliation check for an offering
   */
  const reconcile = async (
    req: ReconciliationRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.requestId || 'unknown';
    
    try {
      const user = req.user;
      if (!user?.id) {
        throw Errors.unauthorized('Authentication required');
      }

      const { offeringId, periodStart, periodEnd, options } = req.body;

      if (!offeringId || typeof offeringId !== 'string') {
        throw Errors.validationError('offeringId is required and must be a string');
      }

      if (!periodStart || !periodEnd) {
        throw Errors.validationError('periodStart and periodEnd are required');
      }

      const startDate = new Date(periodStart);
      const endDate = new Date(periodEnd);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.validationError('Invalid date format for periodStart or periodEnd');
      }

      if (endDate <= startDate) {
        throw Errors.validationError('periodEnd must be after periodStart');
      }

      // Authorization check
      if (user.role !== 'admin' && offeringRepo) {
        const offering = await (offeringRepo.findById ?? offeringRepo.getById)(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        const offeringOwnerId = offering.issuer_id ?? offering.issuer_user_id;
        if (offeringOwnerId !== user.id) {
          throw Errors.forbidden('Not authorized to reconcile this offering');
        }
      }

      logger?.info(
        'Starting reconciliation process',
        {
          requestId,
          userId: user.id,
          offeringId,
          periodStart,
          periodEnd,
          options,
        },
        LogLevel.INFO
      );

      const result = await reconciliationService.reconcile(
        offeringId,
        startDate,
        endDate,
        options || {}
      );

      // Create audit log entry
      if (auditLogRepo) {
        try {
          await auditLogRepo.createAuditLog({
            user_id: user.id,
            action: 'RECONCILIATION_PERFORMED',
            resource: `offering:${offeringId}`,
            details: JSON.stringify({
              periodStart,
              periodEnd,
              discrepanciesFound: result.discrepancies.length,
              isBalanced: result.isBalanced,
              totalRevenue: result.summary.totalRevenueReported,
              totalPayouts: result.summary.totalPayouts,
            }),
            ip_address: req.ip,
            user_agent: req.get('User-Agent'),
          });
        } catch (auditError) {
          logger?.error(
            'Failed to create audit log',
            {
              requestId,
              userId: user.id,
              offeringId,
              error: auditError instanceof Error ? auditError.message : 'Unknown error',
            },
            LogLevel.ERROR
          );
        }
      }

      const duration = Date.now() - startTime;
      logger?.info(
        'Reconciliation completed successfully',
        {
          requestId,
          userId: user.id,
          offeringId,
          duration,
          isBalanced: result.isBalanced,
          discrepanciesCount: result.discrepancies.length,
        },
        LogLevel.INFO
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log Stellar RPC failures if applicable
      if (error && classifyStellarRPCFailure(error) !== StellarRPCFailureClass.UNKNOWN) {
        logger?.warn(
          'Stellar RPC failure in reconciliation',
          {
            requestId,
            userId: req.user?.id,
            offeringId: req.body?.offeringId,
            failureClass: classifyStellarRPCFailure(error),
            duration,
          },
          LogLevel.WARN
        );
      }

      logger?.error(
        'Reconciliation failed',
        {
          requestId,
          userId: req.user?.id,
          offeringId: req.body?.offeringId,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration,
        },
        LogLevel.ERROR
      );
      
      next(error);
    }
  };

  /**
   * GET /api/reconciliation/balance-check/:offeringId
   * Perform quick balance check
   */
  const quickBalanceCheck = async (
    req: ReconciliationRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.requestId || 'unknown';
    
    try {
      const user = req.user;
      if (!user?.id) {
        throw Errors.unauthorized('Authentication required');
      }

      const { offeringId } = req.params;
      const { periodStart, periodEnd } = req.query;

      if (!offeringId) {
        throw Errors.validationError('offeringId is required');
      }

      if (!periodStart || !periodEnd) {
        throw Errors.validationError('periodStart and periodEnd query params are required');
      }

      const startDate = new Date(periodStart as string);
      const endDate = new Date(periodEnd as string);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.validationError('Invalid date format');
      }

      // Authorization check
      if (user.role !== 'admin' && offeringRepo) {
        const offering = await (offeringRepo.findById ?? offeringRepo.getById)(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        const offeringOwnerId = offering.issuer_id ?? offering.issuer_user_id;
        if (offeringOwnerId !== user.id) {
          throw Errors.forbidden('Not authorized to check this offering');
        }
      }

      logger?.info(
        'Starting quick balance check',
        {
          requestId,
          userId: user.id,
          offeringId,
          periodStart: startDate,
          periodEnd: endDate,
        },
        LogLevel.INFO
      );

      const result = await reconciliationService.quickBalanceCheck(
        offeringId,
        startDate,
        endDate
      );

      // Create audit log entry
      if (auditLogRepo) {
        try {
          await auditLogRepo.createAuditLog({
            user_id: user.id,
            action: 'BALANCE_CHECK_PERFORMED',
            resource: `offering:${offeringId}`,
            details: JSON.stringify({
              periodStart: startDate,
              periodEnd: endDate,
              isBalanced: result.isBalanced,
              difference: result.difference,
            }),
            ip_address: req.ip,
            user_agent: req.get('User-Agent'),
          });
        } catch (auditError) {
          logger?.error(
            'Failed to create audit log for balance check',
            {
              requestId,
              userId: user.id,
              offeringId,
              error: auditError instanceof Error ? auditError.message : 'Unknown error',
            },
            LogLevel.ERROR
          );
        }
      }

      const duration = Date.now() - startTime;
      logger?.info(
        'Balance check completed successfully',
        {
          requestId,
          userId: user.id,
          offeringId,
          duration,
          isBalanced: result.isBalanced,
          difference: result.difference,
        },
        LogLevel.INFO
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log Stellar RPC failures if applicable
      if (error && classifyStellarRPCFailure(error) !== StellarRPCFailureClass.UNKNOWN) {
        logger?.warn(
          'Stellar RPC failure in balance check',
          {
            requestId,
            userId: req.user?.id,
            offeringId: req.params?.offeringId,
            failureClass: classifyStellarRPCFailure(error),
            duration,
          },
          LogLevel.WARN
        );
      }

      logger?.error(
        'Balance check failed',
        {
          requestId,
          userId: req.user?.id,
          offeringId: req.params?.offeringId,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration,
        },
        LogLevel.ERROR
      );
      
      next(error);
    }
  };

  /**
   * POST /api/reconciliation/verify-distribution/:runId
   * Verify integrity of a distribution run
   */
  const verifyDistribution = async (
    req: ReconciliationRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.requestId || 'unknown';
    
    try {
      const user = req.user;
      if (!user?.id) {
        throw Errors.unauthorized('Authentication required');
      }

      const { runId } = req.params;

      if (!runId) {
        throw Errors.validationError('runId is required');
      }

      if (user.role !== 'admin') {
        throw Errors.forbidden('Admin role required to verify distribution runs');
      }

      logger?.info(
        'Starting distribution verification',
        {
          requestId,
          userId: user.id,
          runId,
        },
        LogLevel.INFO
      );

      const result = await reconciliationService.verifyDistributionRun(runId);

      // Create audit log entry
      if (auditLogRepo) {
        try {
          await auditLogRepo.createAuditLog({
            user_id: user.id,
            action: 'DISTRIBUTION_VERIFIED',
            resource: `distribution_run:${runId}`,
            details: JSON.stringify({
              runId,
              isValid: result.isValid,
              errorsFound: result.errors.length,
            }),
            ip_address: req.ip,
            user_agent: req.get('User-Agent'),
          });
        } catch (auditError) {
          logger?.error(
            'Failed to create audit log for distribution verification',
            {
              requestId,
              userId: user.id,
              runId,
              error: auditError instanceof Error ? auditError.message : 'Unknown error',
            },
            LogLevel.ERROR
          );
        }
      }

      const duration = Date.now() - startTime;
      logger?.info(
        'Distribution verification completed',
        {
          requestId,
          userId: user.id,
          runId,
          duration,
          isValid: result.isValid,
          errorsCount: result.errors.length,
        },
        LogLevel.INFO
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log Stellar RPC failures if applicable
      if (error && classifyStellarRPCFailure(error) !== StellarRPCFailureClass.UNKNOWN) {
        logger?.warn(
          'Stellar RPC failure in distribution verification',
          {
            requestId,
            userId: req.user?.id,
            runId: req.params?.runId,
            failureClass: classifyStellarRPCFailure(error),
            duration,
          },
          LogLevel.WARN
        );
      }

      logger?.error(
        'Distribution verification failed',
        {
          requestId,
          userId: req.user?.id,
          runId: req.params?.runId,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration,
        },
        LogLevel.ERROR
      );
      
      next(error);
    }
  };

  /**
   * POST /api/reconciliation/validate-report
   * Validate a revenue report before submission
   */
  const validateReport = async (
    req: ReconciliationRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.requestId || 'unknown';
    
    try {
      const user = req.user;
      if (!user?.id) {
        throw Errors.unauthorized('Authentication required');
      }

      const { offeringId, amount, periodStart, periodEnd } = req.body;

      if (!offeringId) {
        throw Errors.validationError('offeringId is required');
      }

      if (!amount || typeof amount !== 'string') {
        throw Errors.validationError('amount is required and must be a string');
      }

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum < 0) {
        throw Errors.validationError('amount must be a non-negative number');
      }

      if (!periodStart || !periodEnd) {
        throw Errors.validationError('periodStart and periodEnd are required');
      }

      const startDate = new Date(periodStart);
      const endDate = new Date(periodEnd);

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.validationError('Invalid date format');
      }

      // Authorization check
      if (user.role !== 'admin' && offeringRepo) {
        const offering = await (offeringRepo.findById ?? offeringRepo.getById)(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        const offeringOwnerId = offering.issuer_id ?? offering.issuer_user_id;
        if (offeringOwnerId !== user.id) {
          throw Errors.forbidden('Not authorized for this offering');
        }
      }

      logger?.info(
        'Starting revenue report validation',
        {
          requestId,
          userId: user.id,
          offeringId,
          amount,
          periodStart: startDate,
          periodEnd: endDate,
        },
        LogLevel.INFO
      );

      const result = await reconciliationService.validateRevenueReport(
        offeringId,
        amount,
        startDate,
        endDate
      );

      // Create audit log entry
      if (auditLogRepo) {
        try {
          await auditLogRepo.createAuditLog({
            user_id: user.id,
            action: 'REVENUE_REPORT_VALIDATED',
            resource: `offering:${offeringId}`,
            details: JSON.stringify({
              offeringId,
              amount,
              periodStart: startDate,
              periodEnd: endDate,
              isValid: result.isValid,
              errorsFound: result.errors.length,
            }),
            ip_address: req.ip,
            user_agent: req.get('User-Agent'),
          });
        } catch (auditError) {
          logger?.error(
            'Failed to create audit log for revenue report validation',
            {
              requestId,
              userId: user.id,
              offeringId,
              error: auditError instanceof Error ? auditError.message : 'Unknown error',
            },
            LogLevel.ERROR
          );
        }
      }

      const duration = Date.now() - startTime;
      logger?.info(
        'Revenue report validation completed',
        {
          requestId,
          userId: user.id,
          offeringId,
          duration,
          isValid: result.isValid,
          errorsCount: result.errors.length,
        },
        LogLevel.INFO
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Log Stellar RPC failures if applicable
      if (error && classifyStellarRPCFailure(error) !== StellarRPCFailureClass.UNKNOWN) {
        logger?.warn(
          'Stellar RPC failure in revenue report validation',
          {
            requestId,
            userId: req.user?.id,
            offeringId: req.body?.offeringId,
            failureClass: classifyStellarRPCFailure(error),
            duration,
          },
          LogLevel.WARN
        );
      }

      logger?.error(
        'Revenue report validation failed',
        {
          requestId,
          userId: req.user?.id,
          offeringId: req.body?.offeringId,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration,
        },
        LogLevel.ERROR
      );
      
      next(error);
    }
  };

  return {
    reconcile,
    quickBalanceCheck,
    verifyDistribution,
    validateReport,
  };
}

export interface CreateReconciliationRouterOptions {
  db: Pool;
  offeringRepo?: OfferingRepository;
  auditLogRepo?: AuditLogRepository;
  logger?: Logger;
  requireAuth: RequestHandler;
}

export function createReconciliationRouter(
  options: CreateReconciliationRouterOptions
): Router {
  const router = Router();
  const reconciliationService = new RevenueReconciliationService(options.db);
  const handlers = createReconciliationHandlers(
    reconciliationService,
    options.offeringRepo,
    options.auditLogRepo,
    options.logger
  );

  router.post('/reconcile', options.requireAuth as any, handlers.reconcile);
  router.get(
    '/balance-check/:offeringId',
    options.requireAuth as any,
    handlers.quickBalanceCheck
  );
  router.post(
    '/verify-distribution/:runId',
    options.requireAuth as any,
    handlers.verifyDistribution
  );
  router.post('/validate-report', options.requireAuth as any, handlers.validateReport);

  return router;
}

export default createReconciliationRouter;
