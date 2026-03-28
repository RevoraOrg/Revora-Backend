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

export interface ReconciliationRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
}

export interface OfferingRepository {
  getById?: (id: string) => Promise<{ id: string; issuer_id?: string; issuer_user_id?: string } | null>;
  findById: (id: string) => Promise<{ id: string; issuer_id?: string; issuer_user_id?: string } | null>;
}

export function createReconciliationHandlers(
  reconciliationService: RevenueReconciliationService,
  offeringRepo?: OfferingRepository
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

      const result = await reconciliationService.reconcile(
        offeringId,
        startDate,
        endDate,
        options || {}
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
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

      const result = await reconciliationService.quickBalanceCheck(
        offeringId,
        startDate,
        endDate
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
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

      const result = await reconciliationService.verifyDistributionRun(runId);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
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

      const result = await reconciliationService.validateRevenueReport(
        offeringId,
        amount,
        startDate,
        endDate
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
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
  requireAuth: RequestHandler;
}

export function createReconciliationRouter(
  options: CreateReconciliationRouterOptions
): Router {
  const router = Router();
  const reconciliationService = new RevenueReconciliationService(options.db);
  const handlers = createReconciliationHandlers(
    reconciliationService,
    options.offeringRepo
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
