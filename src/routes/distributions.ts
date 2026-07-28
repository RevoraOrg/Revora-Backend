import express, { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';

export interface OfferingRepo {
  getById: (id: string) => Promise<Offering | null>;
}

export interface Offering {
  id: string;
  issuer_id?: string;
}

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

      // Authorization: admin allowed; startup must be issuer of offering
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

      // Return summary with structured response
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

  return { triggerDistribution };
}

export default function createDistributionsRouter(opts: { distributionEngine: any; offeringRepo?: OfferingRepo; verifyJWT: express.RequestHandler }) {
  const router = express.Router();
  const handlers = createDistributionHandlers(opts.distributionEngine, opts.offeringRepo);

  router.post('/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);

  return router;
}
