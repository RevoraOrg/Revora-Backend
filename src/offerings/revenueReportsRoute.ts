import { NextFunction, Request, RequestHandler, Response, Router } from 'express';

export interface RevenueReport {
  id: string;
  offering_id: string;
  period_id: string;
  total_revenue: string;
  created_at: Date;
  updated_at: Date;
}

export interface RevenueReportRepository {
  listByOffering(offeringId: string): Promise<RevenueReport[]>;
}

export interface OfferingOwnershipRepository {
  isOwnedByUser(offeringId: string, userId: string): Promise<boolean>;
}

interface CreateRevenueReportsRouteDeps {
  requireAuth: RequestHandler;
  revenueReportRepository: RevenueReportRepository;
  offeringOwnershipRepository: OfferingOwnershipRepository;
}

interface QueryShape {
  periodFrom?: string;
  periodTo?: string;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const getStringQueryParam = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
};

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

  const periodFrom = getStringQueryParam(req.query.periodFrom);
  const periodTo = getStringQueryParam(req.query.periodTo);

  if (periodFrom && periodTo && periodFrom > periodTo) {
    return null;
  }

  return {
    periodFrom,
    periodTo,
    page: page ?? DEFAULT_PAGE,
    pageSize: Math.min(pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  };
};

const getUserId = (req: Request): string | undefined => {
  const fromUser = (req as any).user?.id;
  const fromAuth = (req as any).auth?.userId;
  return fromUser ?? fromAuth;
};

export const createListRevenueReportsHandler = ({
  revenueReportRepository,
  offeringOwnershipRepository,
}: Omit<CreateRevenueReportsRouteDeps, 'requireAuth'>): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = getUserId(req);

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const offeringId = req.params.id;
      const query = parseQuery(req);

      if (!offeringId || !query) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }

      const ownsOffering = await offeringOwnershipRepository.isOwnedByUser(
        offeringId,
        userId
      );

      if (!ownsOffering) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const reports = await revenueReportRepository.listByOffering(offeringId);
      const filteredReports = reports.filter((report) => {
        if (query.periodFrom && report.period_id < query.periodFrom) {
          return false;
        }
        if (query.periodTo && report.period_id > query.periodTo) {
          return false;
        }
        return true;
      });

      const offset = (query.page - 1) * query.pageSize;
      const paginatedReports = filteredReports.slice(offset, offset + query.pageSize);
      const total = filteredReports.length;

      res.status(200).json({
        data: paginatedReports,
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

export const createRevenueReportsRouter = ({
  requireAuth,
  revenueReportRepository,
  offeringOwnershipRepository,
}: CreateRevenueReportsRouteDeps): Router => {
  const router = Router();

  router.get(
    '/api/offerings/:id/revenue-reports',
    requireAuth,
    createListRevenueReportsHandler({
      revenueReportRepository,
      offeringOwnershipRepository,
    })
  );

  return router;
};
