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
  /**
   * Preferred catalog source. Implementations MUST already return only
   * client-safe fields; the route forwards the rows verbatim.
   */
  listPublic?: (opts?: { status?: string; limit?: number; offset?: number; sort?: string }) => Promise<Partial<Offering>[]>;
  countPublic?: (opts?: { status?: string }) => Promise<number>;
  /**
   * Fallback catalog source for repositories that only expose raw rows.
   * Rows returned here are treated as untrusted: the route applies status
   * filtering, stable ordering and pagination itself, then projects each row
   * through `toPublicOffering` so issuer-only fields can never leak.
   *
   * `limit`/`offset`/`sort` are intentionally NOT forwarded — the route owns
   * the window so that `total` stays accurate and pagination is deterministic.
   */
  list?: (opts?: { status?: string }) => Promise<Offering[]>;
}

/**
 * Upper bound for a caller-supplied `limit` on the public catalog.
 * @dev Matches the validation cap enforced by `listCatalog`; larger values are
 *      rejected with 400 rather than silently clamped.
 */
export const PUBLIC_CATALOG_MAX_LIMIT = 1000;

/**
 * Page size used by the built-in fallback when the client omits `limit`, so an
 * unbounded repository read can never be returned in a single response.
 */
export const PUBLIC_CATALOG_DEFAULT_LIMIT = 100;

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

/**
 * Stable public-catalog ordering: newest first, ties broken by ascending id.
 * @dev The id tiebreaker is what makes offset pagination deterministic — without
 *      it, rows sharing a `created_at` could shift between pages and a caller
 *      could see duplicates or miss records entirely.
 */
function comparePublicCatalogRows(a: Partial<Offering>, b: Partial<Offering>): number {
  const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
  const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
  if (aTime !== bTime) return bTime - aTime;
  const aId = typeof a.id === 'string' ? a.id : '';
  const bId = typeof b.id === 'string' ? b.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * Applies the public-catalog contract (status filter -> stable order -> window)
 * to raw repository rows and strips every non-public field.
 */
function selectPublicCatalog(
  rows: Offering[],
  opts: { status?: string; limit?: number; offset?: number },
): Partial<Offering>[] {
  const filtered = opts.status ? rows.filter((row) => row.status === opts.status) : rows.slice();
  const ordered = filtered.sort(comparePublicCatalogRows);
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? PUBLIC_CATALOG_DEFAULT_LIMIT;
  return ordered.slice(offset, offset + limit).map(toPublicOffering);
}

export function createOfferingHandlers(offeringRepo: OfferingRepo) {
  async function listOfferings(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        globalLogger.warn('Unauthorized access attempt to offerings list');
        return next(Errors.unauthorized());
      }
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
      // FIX: Original had two catch blocks on the same try — TypeScript only allows
      // one. The first erroneous catch referenced out-of-scope `result` and used
      // res.json instead of next(err). Replaced with a single correct catch.
      return next(err);
    }
  }

  async function approveOffering(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
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
        if (isNaN(limit) || limit < 0 || limit > PUBLIC_CATALOG_MAX_LIMIT) {
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
      const canCount = typeof offeringRepo.countPublic === 'function';

      // Success contract A: repository owns the public projection and window.
      if (typeof offeringRepo.listPublic === 'function') {
        const offerings = await offeringRepo.listPublic({ status, limit, offset, sort });
        const result: { offerings: Partial<Offering>[]; total?: number } = { offerings };
        if (canCount) {
          result.total = await offeringRepo.countPublic!({ status });
        }

        globalLogger.info('Catalog list fetched', { status, limit, offset, sort, count: offerings.length, source: 'listPublic' });
        return res.json(result);
      }

      // Success contract B (fallback): repository exposes raw rows only. The route
      // filters, stably orders and windows them, and derives `total` from the
      // pre-pagination count so the value stays page-independent.
      if (typeof offeringRepo.list === 'function') {
        const rows = await offeringRepo.list({ status });
        const offerings = selectPublicCatalog(rows, { status, limit, offset });
        const result: { offerings: Partial<Offering>[]; total: number } = { offerings, total: 0 };
        result.total = canCount
          ? await offeringRepo.countPublic!({ status })
          : (status ? rows.filter((row) => row.status === status) : rows).length;

        globalLogger.info('Catalog list fetched', { status, limit, offset, sort, count: offerings.length, source: 'list' });
        return res.json(result);
      }

      // Failure contract: no catalog source at all is a wiring defect, not a
      // client error. Logged at error level for alerting, surfaced as a generic
      // 500 so internal topology is never disclosed.
      globalLogger.error('Public catalog unavailable: offeringRepo exposes neither listPublic nor list', { status });
      return next(Errors.internal('Internal server error'));
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

      globalLogger.info('Offering detail fetched', { id, isIssuer, userId: user?.id });
      return res.json(isIssuer ? offering : toPublicOffering(offering));
    } catch (err) {
      return next(err);
    }
  }

  return { listCatalog, getOfferingById };
}

export default function createOfferingsRouter(opts: {
  offeringRepo: OfferingRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createOfferingHandlers(opts.offeringRepo);
  const publicHandlers = createPublicHandlers(opts.offeringRepo);

  router.get('/api/startup/offerings', opts.verifyJWT, handlers.listOfferings);
  router.post('/api/startup/offerings/:id/approve', opts.verifyJWT, verifyAdminSignature(), handlers.approveOffering);
  router.post('/api/startup/offerings/:id/reject', opts.verifyJWT, verifyAdminSignature(), handlers.rejectOffering);
  router.post('/api/startup/offerings/:id/archive', opts.verifyJWT, verifyAdminSignature(), handlers.archiveOffering);
  router.get('/api/offerings', publicHandlers.listCatalog);
  router.get('/api/offerings/:id', publicHandlers.getOfferingById);

  return router;
}
