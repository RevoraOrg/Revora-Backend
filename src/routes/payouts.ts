import express, { Request, Response, NextFunction } from 'express';

export interface Payout {
  id: string;
  distribution_run_id: string;
  investor_id: string;
  amount: string;
  status: 'pending' | 'processed' | 'failed';
  transaction_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface PayoutRepo {
  listPayoutsByInvestor: (investorId: string) => Promise<Payout[]>;
}

export function createPayoutsHandlers(payoutRepo: PayoutRepo) {
  async function listPayouts(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
      if (user.role !== 'investor') return res.status(403).json({ error: 'Forbidden' });

      const status = typeof req.query.status === 'string' ? req.query.status : undefined;

      const limitRaw =
        req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined;
      const offsetRaw =
        req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : undefined;

      if (limitRaw !== undefined && (isNaN(limitRaw) || limitRaw < 0)) {
        return res.status(400).json({ error: 'Invalid limit' });
      }
      if (offsetRaw !== undefined && (isNaN(offsetRaw) || offsetRaw < 0)) {
        return res.status(400).json({ error: 'Invalid offset' });
      }

      const limit = limitRaw;
      const offset = offsetRaw ?? 0;

      let payouts = await payoutRepo.listPayoutsByInvestor(user.id);

      // Filter by status
      if (status !== undefined) {
        payouts = payouts.filter((p) => p.status === status);
      }

      const total = payouts.length;

      // Paginate
      if (offset > 0) payouts = payouts.slice(offset);
      if (limit !== undefined) payouts = payouts.slice(0, limit);

      return res.json({ payouts, total });
    } catch (err) {
      return next(err);
    }
  }

  return { listPayouts };
}

export default function createPayoutsRouter(opts: {
  payoutRepo: PayoutRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createPayoutsHandlers(opts.payoutRepo);

  router.get('/api/investments/payouts', opts.verifyJWT, handlers.listPayouts);

  return router;
}
