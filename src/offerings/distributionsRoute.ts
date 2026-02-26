import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

// ─── Domain types ────────────────────────────────────────────────────────────

/** Mirrors the DistributionRun shape from distributionRepository.ts */
export interface DistributionRun {
  id: string;
  offering_id: string;
  total_amount: string;
  distribution_date: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: Date;
  updated_at: Date;
}

// ─── Repository contracts (interfaces only – no concrete import needed) ──────

export interface DistributionRepository {
  listByOffering(offeringId: string): Promise<DistributionRun[]>;
}

export interface OfferingOwnershipRepository {
  isOwnedByUser(offeringId: string, userId: string): Promise<boolean>;
}

// ─── Dependency shapes ───────────────────────────────────────────────────────

interface CreateDistributionsRouteDeps {
  requireAuth: RequestHandler;
  distributionRepository: DistributionRepository;
  offeringOwnershipRepository: OfferingOwnershipRepository;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

interface QueryShape {
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Parse a value that must be a positive integer if present. */
const parsePositiveInt = (value: unknown): number | null => {
  if (value === undefined) return null;
  if (Array.isArray(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseQuery = (req: Request): QueryShape | null => {
  const page = parsePositiveInt(req.query.page);
  const pageSize = parsePositiveInt(req.query.pageSize);

  if (req.query.page !== undefined && page === null) {
    return null;
  }
  if (req.query.pageSize !== undefined && pageSize === null) {
    return null;
  }

  return {
    page: page ?? DEFAULT_PAGE,
    pageSize: Math.min(pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
};

// ─── Auth helper ─────────────────────────────────────────────────────────────

/** Resolves user id from req.user (JWT middleware) or req.auth (Clerk/etc.) */
const getUserId = (req: Request): string | undefined => {
  const fromUser = (req as any).user?.id;
  const fromAuth = (req as any).auth?.userId;
  return fromUser ?? fromAuth;
};

// ─── Handler factory (exported for unit tests) ───────────────────────────────

export const createListDistributionsByOfferingHandler = ({
  distributionRepository,
  offeringOwnershipRepository,
}: Omit<CreateDistributionsRouteDeps, 'requireAuth'>): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // 1. Authentication
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // 2. Path param
      const offeringId = req.params.id;
      if (!offeringId) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      // 3. Pagination query params
      const query = parseQuery(req);
      if (!query) {
        res.status(400).json({ error: 'Invalid pagination parameters' });
        return;
      }

      // 4. Ownership check — issuer must own the offering
      const ownsOffering = await offeringOwnershipRepository.isOwnedByUser(
        offeringId,
        userId
      );
      if (!ownsOffering) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // 5. Fetch distributions for this offering
      const distributions = await distributionRepository.listByOffering(offeringId);

      // 6. Paginate in-memory (listByOffering already orders by distribution_date DESC)
      const total = distributions.length;
      const offset = (query.page - 1) * query.pageSize;
      const data = distributions.slice(offset, offset + query.pageSize);

      // 7. Respond
      res.status(200).json({
        data,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total,
          totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
        },
      });
    } catch (error) {
      next(error);
    }
  };
};

// ─── Router factory ──────────────────────────────────────────────────────────

export const createDistributionsRouter = ({
  requireAuth,
  distributionRepository,
  offeringOwnershipRepository,
}: CreateDistributionsRouteDeps): Router => {
  const router = Router();

  router.get(
    '/api/offerings/:id/distributions',
    requireAuth,
    createListDistributionsByOfferingHandler({
      distributionRepository,
      offeringOwnershipRepository,
    })
  );

  return router;
};