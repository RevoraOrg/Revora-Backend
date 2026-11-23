import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { requireInvestor, AuthenticatedRequest } from '../middleware/auth';
import { InvestmentService } from '../services/investmentService';
import { createInvestmentServiceWithScreening } from '../services/investmentServiceSetup';
import { AppError } from '../lib/errors';
import {
  createIdempotencyMiddleware,
  IdempotencyStore,
  PostgresIdempotencyStore,
} from '../middleware/idempotency';
import { requireMobileAttestation } from '../security/mobileAttestation';
import { AMLService, createAMLService } from '../aml/amlService';
import { InMemorySecurityAuditRepository } from '../security/audit';
import crypto from 'crypto';
import { z } from 'zod';
import { isPositiveDecimalAmount } from '../lib/amountValidation';

const investmentBodySchema = z.object({
  offering_id: z.string({ error: 'offering_id is required' }).uuid({
    error: 'offering_id must be a valid UUID',
  }),
  amount: z.string({ error: 'amount is required' }).refine(
    isPositiveDecimalAmount,
    'amount must be a positive decimal string with up to 10 decimal places',
  ),
  asset: z.string({ error: 'asset is required' }).max(12, {
    error: 'asset must be at most 12 characters',
  }).trim().min(1, { error: 'asset is required' }),
  beneficial_owners: z.array(z.string()).optional(),
});

function validateInvestmentBody(req: Request, res: Response, next: NextFunction): void {
  const result = investmentBodySchema.safeParse(req.body);
  if (!result.success) {
    const fieldErrors = result.error.issues.reduce<Record<string, string[]>>((errors, issue) => {
      const field = issue.path.join('.') || 'body';
      (errors[field] ??= []).push(issue.message);
      return errors;
    }, {});
    res.status(400).json({
      error: result.error.issues[0].message,
      details: fieldErrors,
    });
    return;
  }

  req.body = result.data;
  next();
}

export const DEFAULT_INVESTMENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface InvestmentsRouterOptions {
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlMs?: number;
  investmentService?: InvestmentService;
}

/**
 * Fingerprint function for investment requests.
 * Creates a deterministic hash of the request body to detect payload changes.
 * Includes beneficial_owners to ensure changes in screened owners invalidate replay.
 */
function fingerprintInvestmentRequest(req: Request): string {
  const body = (req.body || {}) as Record<string, unknown>;
  const beneficial_owners =
    Array.isArray(body.beneficial_owners) && body.beneficial_owners.length > 0
      ? body.beneficial_owners
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.trim())
      : undefined;

  // Normalize by extracting only relevant fields in a consistent order
  const normalized = JSON.stringify({
    amount: body.amount,
    asset: body.asset,
    beneficial_owners:
      beneficial_owners && beneficial_owners.length > 0 ? beneficial_owners : undefined,
    offering_id: body.offering_id,
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Middleware to require Idempotency-Key header on POST requests.
 */
function requireIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'POST') {
    const key = req.header('idempotency-key');
    if (!key || key.trim() === '') {
      res.status(400).json({
        error: 'Idempotency-Key header is required for investment submissions',
      });
      return;
    }
  }
  next();
}

/**
 * Optional dependencies that callers may inject into the investments router.
 * Providing a pre-built `amlService` is preferred in production so that a
 * single AML service instance is shared across routers (avoids duplicate repos
 * and audit-log repositories).  When omitted the router builds one internally
 * using an in-memory audit repository, which is acceptable for the API role but
 * means AML audit events won't reach the persistent security-audit store.
 */
export interface InvestmentsRouterDeps {
  /** AML service used for transaction monitoring after each investment is created. */
  amlService?: AMLService;
  /**
   * Pre-built InvestmentService.  Intended for tests that need to inject a
   * spy service without wiring a full DB stack.  In production this should
   * always be omitted so the router builds the service with its real repos.
   */
  investmentService?: InvestmentService;
}

/**
 * Factory that creates an Express Router for investment endpoints.
 * Requires the caller to supply a pg Pool for database access.
 *
 * @param db   - Postgres connection pool.
 * @param deps - Optional dependencies.  Pass `{ amlService }` to wire transaction
 *               monitoring; omitting it causes the router to build a default
 *               AML service backed by an in-memory audit repository.
 */
export function createInvestmentsRouter(db: Pool, deps: InvestmentsRouterDeps = {}): Router {
  const router = Router();
  const investmentRepo = new InvestmentRepository(db);

  // Resolve AML service: prefer an injected one (e.g. from index.ts where the
  // shared InMemorySecurityAuditRepository is already wired), fall back to
  // building a standalone instance.  Never pass undefined — the absence of AML
  // monitoring was the root bug (#1288).
  const amlService: AMLService =
    deps.amlService ??
    createAMLService(db, new InMemorySecurityAuditRepository(), 'system');

  const investmentService: InvestmentService =
    deps.investmentService ??
    createInvestmentServiceWithScreening(db, amlService);

  const ttlMs = options.idempotencyTtlMs ?? DEFAULT_INVESTMENT_IDEMPOTENCY_TTL_MS;
  const store =
    options.idempotencyStore ||
    new PostgresIdempotencyStore({
      pool: db,
      ttlMs,
    });

  // Create idempotency middleware with request body fingerprinting and principal isolation
  const idempotencyMiddleware = createIdempotencyMiddleware({
    store,
    fingerprint: fingerprintInvestmentRequest,
    requirePrincipal: true,
    routePath: '/api/investments',
  });

  /**
   * POST /api/investments
   * Create a new investment for an offering.
   * 
   * Request body:
   *   offering_id - UUID of the offering to invest in (required)
   *   amount - Amount to invest as a string (required, positive number)
   *   asset - Asset code (e.g., 'USDC') (required)
   * 
   * Headers:
   *   Idempotency-Key - Required for POST requests to prevent duplicate submissions
   */
  router.post(
    '/',
    requireInvestor,
    requireIdempotencyKey,
    validateInvestmentBody,
    idempotencyMiddleware,
    requireMobileAttestation,
    async (req: Request, res: Response, next: NextFunction) => {
    const authenticatedReq = req as AuthenticatedRequest;
    
    // Type guard to ensure user is defined
    if (!authenticatedReq.user) {
      res.status(401).json({ error: 'Unauthorized: User not authenticated' });
      return;
    }
    
    const investorId = String(authenticatedReq.user.id);

    const { offering_id, amount, asset, beneficial_owners } = req.body as z.infer<
      typeof investmentBodySchema
    >;
    const screenedBeneficialOwners = beneficial_owners
      ?.map((owner) => owner.trim())
      .filter((owner) => owner.length > 0);

    try {
      const investment = await investmentService.createInvestment({
        investor_id: investorId,
        offering_id,
        amount,
        asset,
        beneficial_owners: screenedBeneficialOwners,
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
