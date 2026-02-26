import express, { Request, Response, NextFunction } from 'express';

export interface OfferingRepo {
  getById: (id: string) => Promise<{ id: string; issuer_id: string } | null>;
}

export function createDistributionHandlers(distributionEngine: any, offeringRepo?: OfferingRepo) {
  async function triggerDistribution(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });

      const offeringId = String(req.params.id || '');
      if (!offeringId) return res.status(400).json({ error: 'Missing offering id' });

      const revenueRaw = req.body?.revenue_amount ?? req.body?.revenueAmount;
      const revenueAmount = revenueRaw !== undefined ? Number(revenueRaw) : NaN;
      if (Number.isNaN(revenueAmount) || revenueAmount <= 0) return res.status(400).json({ error: 'Invalid revenue amount' });

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) return res.status(400).json({ error: 'Missing distribution period' });
      const period = { start: new Date(startRaw), end: new Date(endRaw) };

      // Authorization: admin allowed; startup must be issuer of offering
      if (user.role !== 'admin') {
        if (user.role !== 'startup') return res.status(403).json({ error: 'Forbidden' });
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          return res.status(403).json({ error: 'Forbidden: cannot verify issuer' });
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) return res.status(404).json({ error: 'Offering not found' });
        if (offering.issuer_id !== user.id) return res.status(403).json({ error: 'Forbidden' });
      }

      const result = await distributionEngine.distribute(offeringId, period, revenueAmount);

      // Return summary
      return res.status(200).json({ run_id: result.distributionRun?.id, payouts: result.payouts });
    } catch (err) {
      return next(err);
    }
  }

  return { triggerDistribution };
}

export default function createDistributionsRouter(opts: { distributionEngine: any; offeringRepo?: OfferingRepo; verifyJWT: express.RequestHandler }) {
  const router = express.Router();
  const handlers = createDistributionHandlers(opts.distributionEngine, opts.offeringRepo);

  router.post('/api/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);

  return router;
}
