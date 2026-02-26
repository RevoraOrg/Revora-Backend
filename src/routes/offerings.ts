import express, { Request, Response, NextFunction } from 'express';

export interface Offering {
  id: string;
  issuer_id: string;
  title: string;
  status: string;
  amount: string;
  created_at: Date;
}

export interface OfferingRepo {
  listByIssuer: (issuerId: string, opts?: { status?: string; limit?: number; offset?: number }) => Promise<Offering[]>;
  countByIssuer?: (issuerId: string, opts?: { status?: string }) => Promise<number>;
  // Optional public listing for investors / catalog
  listPublic?: (opts?: { status?: string; limit?: number; offset?: number; sort?: string }) => Promise<Partial<Offering>[]>;
  countPublic?: (opts?: { status?: string }) => Promise<number>;
}

export function createOfferingHandlers(offeringRepo: OfferingRepo) {
  async function listOfferings(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
      // Only startups allowed; optional role check
      if (user.role && user.role !== 'startup') return res.status(403).json({ error: 'Forbidden' });

      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const limit = req.query.limit ? Math.max(0, parseInt(String(req.query.limit), 10) || 0) : undefined;
      const offset = req.query.offset ? Math.max(0, parseInt(String(req.query.offset), 10) || 0) : undefined;

      const offerings = await offeringRepo.listByIssuer(user.id, { status, limit, offset });
      const result: any = { offerings };
      if (typeof offeringRepo.countByIssuer === 'function') {
        const total = await offeringRepo.countByIssuer(user.id, { status });
        result.total = total;
      }
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  return { listOfferings };
}

export function createPublicHandlers(offeringRepo: OfferingRepo) {
  async function listCatalog(req: Request, res: Response, next: NextFunction) {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const limit = req.query.limit ? Math.max(0, parseInt(String(req.query.limit), 10) || 0) : undefined;
      const offset = req.query.offset ? Math.max(0, parseInt(String(req.query.offset), 10) || 0) : undefined;
      const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;

      if (typeof offeringRepo.listPublic !== 'function') {
        throw new Error('offeringRepo.listPublic not implemented');
      }

      const offerings = await offeringRepo.listPublic({ status, limit, offset, sort });
      const result: any = { offerings };
      if (typeof offeringRepo.countPublic === 'function') {
        result.total = await offeringRepo.countPublic({ status });
      }
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  return { listCatalog };
}

export default function createOfferingsRouter(opts: { offeringRepo: OfferingRepo; verifyJWT: express.RequestHandler }) {
  const router = express.Router();
  const handlers = createOfferingHandlers(opts.offeringRepo);
  const publicHandlers = createPublicHandlers(opts.offeringRepo);

  router.get('/api/startup/offerings', opts.verifyJWT, handlers.listOfferings);
  // Public catalog for investors (no auth)
  router.get('/api/offerings', publicHandlers.listCatalog);

  return router;
}
