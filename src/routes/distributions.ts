import express, { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';
import { globalMetrics } from '../lib/metrics';

export interface OfferingRepo {
  getById: (id: string) => Promise<Offering | null>;
  update?: (id: string, input: Record<string, unknown>) => Promise<Offering | null>;
}

export interface Offering {
  id: string;
  issuer_id?: string;
  timezone?: string;
}

export interface ScheduleConfig {
  timezone: string;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function createDistributionHandlers(distributionEngine: any, offeringRepo?: OfferingRepo) {
  async function triggerDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const offeringId = String(req.params.id || '');
      if (!offeringId) {
        throw Errors.badRequest('Missing offering id');
      }

      logger.info('Triggering distribution', {
        offeringId,
        userId: user.id,
        role: user.role,
        requestId,
      });

      const revenueRaw = req.body?.revenue_amount ?? req.body?.revenueAmount;
      const revenueAmount = revenueRaw !== undefined ? Number(revenueRaw) : NaN;
      if (Number.isNaN(revenueAmount) || revenueAmount <= 0) {
        throw Errors.badRequest('Invalid revenue amount');
      }

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) {
        throw Errors.badRequest('Missing distribution period');
      }
      
      const startDate = new Date(startRaw);
      const endDate = new Date(endRaw);
      
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.badRequest('Invalid date format in distribution period');
      }
      
      if (endDate <= startDate) {
        throw Errors.badRequest('End date must be after start date');
      }
      
      const period = { start: startDate, end: endDate };

      if (user.role !== 'admin') {
        if (user.role !== 'startup') {
          throw Errors.forbidden('Forbidden: startup role required');
        }
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          throw Errors.forbidden('Forbidden: cannot verify issuer');
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const result = await distributionEngine.distribute(offeringId, period, revenueAmount);

      logger.info('Distribution triggered successfully', {
        offeringId,
        runId: result.distributionRun?.id,
        payoutCount: result.payouts?.length,
        requestId,
      });
      return res.status(200).json({
        run_id: result.distributionRun?.id,
        payouts: result.payouts,
        total_payouts: result.payouts?.length ?? 0,
        requestId,
      });
    } catch (err) {
      logger.error('Distribution trigger failed', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  async function previewDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const offeringId = String(req.params.id || '');
      if (!offeringId) {
        throw Errors.badRequest('Missing offering id');
      }

      logger.info('Requesting distribution preview', {
        offeringId,
        userId: user.id,
        role: user.role,
        requestId,
      });

      const revenueRaw = req.body?.revenue_amount ?? req.body?.revenueAmount;
      const revenueAmount = revenueRaw !== undefined ? Number(revenueRaw) : NaN;
      if (Number.isNaN(revenueAmount) || revenueAmount <= 0) {
        throw Errors.badRequest('Invalid revenue amount');
      }

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) {
        throw Errors.badRequest('Missing distribution period');
      }
      
      const startDate = new Date(startRaw);
      const endDate = new Date(endRaw);
      
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.badRequest('Invalid date format in distribution period');
      }
      
      if (endDate <= startDate) {
        throw Errors.badRequest('End date must be after start date');
      }
      
      // Include period.id if provided in request, generate a synthetic one for preview if not
      const periodId = req.body?.period?.id ?? `${startRaw}:${endRaw}`;
      const period = { id: periodId, start: startDate, end: endDate };

      // Authorization: same level as real distribution (admin or startup issuer of offering)
      // The data returned (per-investor projected amounts) is real and sensitive,
      // so we gate preview with the same permission level as real execution.
      if (user.role !== 'admin') {
        if (user.role !== 'startup') {
          throw Errors.forbidden('Forbidden: startup role required');
        }
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          throw Errors.forbidden('Forbidden: cannot verify issuer');
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const preview = await distributionEngine.previewRun(offeringId, period, revenueAmount);

      // Emit preview count metric
      // Labels: user_role (safe, low-cardinality), period_id (safe, part of business logic)
      // NO investor-specific data in labels (prevents high-cardinality explosion and data leakage)
      try {
        globalMetrics.incrementCounter('distribution.preview.count', {
          user_role: user.role,
          period_id: periodId,
        });
      } catch (metricsErr) {
        // Log but do not fail the preview if metrics emission fails
        logger.warn('Failed to emit distribution preview metric', {
          previewId: preview.preview_id,
          error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
        });
      }

      logger.info('Distribution preview completed successfully', {
        offeringId,
        previewId: preview.preview_id,
        investorCount: preview.investor_count,
        requestId,
      });

      return res.status(200).json(preview);
    } catch (err) {
      logger.error('Distribution preview failed', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  return { triggerDistribution, previewDistribution };
}

export default function createDistributionsRouter(opts: {
  distributionEngine: any;
  offeringRepo?: OfferingRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createDistributionHandlers(opts.distributionEngine, opts.offeringRepo);

  router.post('/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);
  router.post('/offerings/:id/distribute/preview', opts.verifyJWT, handlers.previewDistribution);

  return router;
}
