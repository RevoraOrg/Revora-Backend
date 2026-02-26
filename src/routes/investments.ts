import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { requireInvestor, AuthenticatedRequest } from '../middleware/auth';

/**
 * Factory that creates an Express Router for GET /api/investments.
 * Requires the caller to supply a pg Pool for database access.
 */
export function createInvestmentsRouter(db: Pool): Router {
  const router = Router();
  const investmentRepo = new InvestmentRepository(db);

  /**
   * GET /api/investments
   * Returns the authenticated investor's investments.
   *
   * Query params:
   *   limit      – maximum number of records (non-negative integer)
   *   offset     – number of records to skip (non-negative integer)
   *   offering_id – filter by a specific offering UUID
   */
  router.get('/', requireInvestor, async (req: Request, res: Response) => {
    const authenticatedReq = req as AuthenticatedRequest;
    const investorId = authenticatedReq.user.id;

    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];
    const offeringId =
      typeof req.query['offering_id'] === 'string'
        ? req.query['offering_id']
        : undefined;

    let limit: number | undefined;
    let offset: number | undefined;

    if (rawLimit !== undefined) {
      limit = parseInt(rawLimit as string, 10);
      if (isNaN(limit) || limit < 0) {
        res.status(400).json({ error: 'Invalid limit parameter' });
        return;
      }
    }

    if (rawOffset !== undefined) {
      offset = parseInt(rawOffset as string, 10);
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({ error: 'Invalid offset parameter' });
        return;
      }
    }

    try {
      const investments = await investmentRepo.listByInvestor({
        investor_id: investorId,
        offering_id: offeringId,
        limit,
        offset,
      });

      res.json({ data: investments });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
