import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { requireInvestor, AuthenticatedRequest } from '../middleware/auth';
import { InvestmentService, createInvestmentService } from '../services/investmentService';
import { AppError } from '../lib/errors';

/**
 * Factory that creates an Express Router for investment endpoints.
 * Requires the caller to supply a pg Pool for database access.
 */
export function createInvestmentsRouter(db: Pool): Router {
  const router = Router();
  const investmentRepo = new InvestmentRepository(db);
  const investmentService: InvestmentService = createInvestmentService(db);

  /**
   * POST /api/investments
   * Create a new investment for an offering.
   * 
   * Request   offering_id - body:
   * UUID of the offering to invest in (required)
   *   amount - Amount to invest as a string (required, positive number)
   *   asset - Asset code (e.g., 'USDC') (required)
   */
  router.post('/', requireInvestor, async (req: Request, res: Response, next: NextFunction) => {
    const authenticatedReq = req as AuthenticatedRequest;
    
    // Type guard to ensure user is defined
    if (!authenticatedReq.user) {
      res.status(401).json({ error: 'Unauthorized: User not authenticated' });
      return;
    }
    
    const investorId = String(authenticatedReq.user.id);

    // Parse and validate request body
    const body = req.body as Record<string, unknown>;
    const offering_id = String(body.offering_id) || undefined;
    const amount = String(body.amount) || undefined;
    const asset = String(body.asset) || undefined;

    // Validate required fields
    if (!offering_id) {
      res.status(400).json({ error: 'offering_id is required' });
      return;
    }

    if (!amount) {
      res.status(400).json({ error: 'amount is required' });
      return;
    }

    if (!asset) {
      res.status(400).json({ error: 'asset is required' });
      return;
    }

    try {
      const investment = await investmentService.createInvestment({
        investor_id: investorId,
        offering_id,
        amount,
        asset,
      });

      res.status(201).json({ data: investment });
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.statusCode).json(error.toResponse());
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

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
    
    // Type guard to ensure user is defined
    if (!authenticatedReq.user) {
      res.status(401).json({ error: 'Unauthorized: User not authenticated' });
      return;
    }
    
    const investorId = String(authenticatedReq.user.id);

    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];
    const offeringId =
      typeof req.query['offering_id'] === 'string'
        ? String(req.query['offering_id'])
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
