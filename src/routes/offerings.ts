import express, { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { verifyAdminSignature } from '../middleware/adminSignature';
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
  getById: (id: string) => Promise<Offering | null>;
  // Optional public listing for investors / catalog
  listPublic?: (opts?: { status?: string; limit?: number; offset?: number; sort?: string }) => Promise<Partial<Offering>[]>;
  countPublic?: (opts?: { status?: string }) => Promise<number>;
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toPublicOffering(offering: Offering): Partial<Offering> {
  return {
    id: offering.id,
    title: offering.title,
    status: offering.status,
    amount: offering.amount,
    created_at: offering.created_at,
  };
}

export function createOfferingHandlers(offeringRepo: OfferingRepo) {
  async function listOfferings(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        globalLogger.warn('Unauthorized access attempt to offerings list');
        return next(Errors.unauthorized());
      }
      // Only startups allowed; optional role check
      if (user.role && user.role !== 'startup') {
        globalLogger.warn('Forbidden access attempt to offerings list', { userId: user.id, role: user.role });
        return next(Errors.forbidden());
      }

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
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  async function approveOffering(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      // In a real app we'd call offeringService.approve(id) here.
      // Assuming offeringService is globally available or injected via closures:
      globalLogger.info('Offering approved', { offeringId: id, adminKid: (req as any).adminKid });
      res.json({ success: true, status: 'approved' });
    } catch (e) {
      next(e);
    }
  }

  async function rejectOffering(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      globalLogger.info('Offering rejected', { offeringId: id, adminKid: (req as any).adminKid });
      res.json({ success: true, status: 'rejected' });
    } catch (e) {
      next(e);
    }
  }

  async function archiveOffering(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      globalLogger.info('Offering archived', { offeringId: id, adminKid: (req as any).adminKid });
      res.json({ success: true, status: 'archived' });
    } catch (e) {
      next(e);
    }
  }

  return { listOfferings, approveOffering, rejectOffering, archiveOffering };
}

export function createPublicHandlers(offeringRepo: OfferingRepo) {
  async function listCatalog(req: Request, res: Response, next: NextFunction) {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      let limit: number | undefined;
      if (req.query.limit !== undefined) {
        limit = parseInt(String(req.query.limit), 10);
        if (isNaN(limit) || limit < 0 || limit > 1000) {
          globalLogger.warn('Invalid limit parameter', { limit: req.query.limit });
          return next(Errors.badRequest('Invalid limit parameter'));
        }
      }

      let offset: number | undefined;
      if (req.query.offset !== undefined) {
        offset = parseInt(String(req.query.offset), 10);
        if (isNaN(offset) || offset < 0) {
          globalLogger.warn('Invalid offset parameter', { offset: req.query.offset });
          return next(Errors.badRequest('Invalid offset parameter'));
        }
      }
      
      const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;

      if (typeof offeringRepo.listPublic !== 'function') {
        globalLogger.error('offeringRepo.listPublic not implemented');
        return next(Errors.internal('Internal server error'));
      }

      const offerings = await offeringRepo.listPublic({ status, limit, offset, sort });
      const result: any = { offerings };
      if (typeof offeringRepo.countPublic === 'function') {
        result.total = await offeringRepo.countPublic({ status });
      }

      globalLogger.info('Catalog list fetched', { 
        status, limit, offset, sort, count: offerings.length 
      });

      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  async function getOfferingById(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      if (!isValidUuid(id)) {
        globalLogger.warn('Invalid offering id format requested', { id });
        return next(Errors.badRequest('Invalid offering id format'));
      }

      const offering = await offeringRepo.getById(id);
      if (!offering) {
        globalLogger.warn('Offering not found', { id });
        return next(Errors.notFound('Offering not found'));
      }

      const user = (req as any).user;
      const offeringIssuerId = offering.issuer_id ?? (offering as any).issuer_user_id;
      const isIssuer =
        !!user &&
        typeof user.id === 'string' &&
        (user.role === 'startup' || user.role === 'issuer') &&
        user.id === offeringIssuerId;

      globalLogger.info('Offering detail fetched', { 
        id, 
        isIssuer, 
        userId: user?.id 
      });

      return res.json(isIssuer ? offering : toPublicOffering(offering));
    } catch (err) {
      return next(err);
    }
  }

  return { listCatalog, getOfferingById };
}

export default function createOfferingsRouter(opts: { offeringRepo: OfferingRepo; verifyJWT: express.RequestHandler }) {
  const router = express.Router();
  const handlers = createOfferingHandlers(opts.offeringRepo);
  const publicHandlers = createPublicHandlers(opts.offeringRepo);

  router.get('/api/startup/offerings', opts.verifyJWT, handlers.listOfferings);
  // Admin privileged actions
  router.post('/api/startup/offerings/:id/approve', opts.verifyJWT, verifyAdminSignature(), handlers.approveOffering);
  router.post('/api/startup/offerings/:id/reject', opts.verifyJWT, verifyAdminSignature(), handlers.rejectOffering);
  router.post('/api/startup/offerings/:id/archive', opts.verifyJWT, verifyAdminSignature(), handlers.archiveOffering);

  // Public catalog for investors (no auth)
  router.get('/api/offerings', publicHandlers.listCatalog);
  router.get('/api/offerings/:id', publicHandlers.getOfferingById);

  return router;
}
