import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface Investment {
  id: string;
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
  status: 'pending' | 'completed' | 'failed';
  tx_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface InvestmentRepository {
  listByOffering(
    offeringId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<Investment[]>;
}

export interface OfferingRecord {
  id: string;
  issuer_id?: string;
  issuer_user_id?: string;
}

export interface OfferingRepository {
  getById(id: string): Promise<OfferingRecord | null>;
}

function parseNonNegativeInt(value: unknown): number | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function getUser(req: Request): { id: string; role?: string } | undefined {
  const fromUser = (req as any).user;
  if (fromUser && typeof fromUser.id === 'string') {
    return { id: fromUser.id, role: fromUser.role };
  }
  const fromAuth = (req as any).auth;
  if (fromAuth && typeof fromAuth.userId === 'string') {
    return { id: fromAuth.userId, role: fromAuth.role };
  }
  return undefined;
}

export const createListInvestmentsByOfferingHandler = ({
  investmentRepository,
  offeringRepository,
}: {
  investmentRepository: InvestmentRepository;
  offeringRepository: OfferingRepository;
}): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = getUser(req);
      if (!user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (user.role !== 'issuer') {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const offeringId = req.params.id;
      if (!offeringId) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      const offering = await offeringRepository.getById(offeringId);
      if (!offering) {
        res.status(404).json({ error: 'Offering not found' });
        return;
      }

      const ownerId = offering.issuer_id ?? offering.issuer_user_id;
      if (ownerId !== user.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const limit = parseNonNegativeInt(req.query.limit);
      const offset = parseNonNegativeInt(req.query.offset);
      if (req.query.limit !== undefined && limit === null) {
        res.status(400).json({ error: 'Invalid limit' });
        return;
      }
      if (req.query.offset !== undefined && offset === null) {
        res.status(400).json({ error: 'Invalid offset' });
        return;
      }

      const data = await investmentRepository.listByOffering(offeringId, {
        limit: limit ?? undefined,
        offset: offset ?? undefined,
      });
      res.status(200).json({ data });
    } catch (err) {
      next(err);
    }
  };
};

export const createOfferingInvestmentsRouter = ({
  requireAuth,
  investmentRepository,
  offeringRepository,
}: {
  requireAuth: RequestHandler;
  investmentRepository: InvestmentRepository;
  offeringRepository: OfferingRepository;
}): Router => {
  const router = Router();
  router.get(
    '/api/offerings/:id/investments',
    requireAuth,
    createListInvestmentsByOfferingHandler({ investmentRepository, offeringRepository })
  );
  return router;
};

