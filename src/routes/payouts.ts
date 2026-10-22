import express, { Request, Response, NextFunction } from 'express';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * @dev Maximum number of records a client may request in a single page.
 * Prevents denial-of-service via arbitrarily large result sets.
 */
const MAX_LIMIT = 100;

/**
 * @dev Default page size when the client omits the `limit` query parameter.
 */
const DEFAULT_LIMIT = 20;

/**
 * @dev Allowed values for the `status` filter.
 * Any value outside this set is rejected with HTTP 400.
 */
const VALID_STATUSES = new Set<string>(['pending', 'processed', 'failed']);

/**
 * @dev Allowed column names for the `sortBy` query parameter.
 * Restricting to a known allowlist prevents injection of arbitrary sort keys.
 * This set is intentionally the same as
 * `DistributionRepository.ALLOWED_PAYOUT_SORT_COLUMNS`: validation happens
 * here at the HTTP boundary so that invalid values are rejected with 400
 * before reaching the repository layer.
 */
const VALID_SORT_FIELDS = new Set<string>(['created_at', 'amount', 'status']);

/**
 * @dev Allowed values for the `sortOrder` query parameter.
 */
const VALID_SORT_ORDERS = new Set<string>(['asc', 'desc']);

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * @title Payout
 * @dev Represents a single payout record belonging to a distribution run.
 *
 * Field names match the `distribution_payouts` table and the repository's
 * `Payout` interface:
 * - `distribution_id`  — FK to `distributions.id`  (not `distribution_run_id`)
 * - `tx_hash`          — Stellar transaction hash   (not `transaction_hash`)
 */
export interface Payout {
  id: string;
  distribution_id: string;
  investor_id: string;
  amount: string;
  status: 'pending' | 'processed' | 'failed';
  tx_hash?: string | null;
  frozen_fx_rate_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * @title PayoutRepo
 * @dev Repository interface consumed by the handler.
 * The handler delegates all filtering, sorting, and pagination to the
 * repository so that the database — not Node — performs the heavy lifting.
 */
export interface PayoutRepo {
  searchPayoutsByInvestor: (params: {
    investorId: string;
    status?: 'pending' | 'processed' | 'failed';
    minAmount?: number;
    maxAmount?: number;
    from?: Date;
    to?: Date;
    sortBy?: 'created_at' | 'amount' | 'status';
    sortOrder?: 'asc' | 'desc';
    limit: number;
    offset: number;
  }) => Promise<{ payouts: Payout[]; total: number }>;
}

/**
 * @title PayoutListResponse
 * @dev Shape of the JSON response for the list endpoint.
 * Includes pagination metadata so clients can implement cursor-free paging.
 */
export interface PayoutListResponse {
  payouts: Payout[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @dev Safely parse a query string value to a non-negative integer.
 * Returns `undefined` when the parameter was not supplied, or a
 * `{ error: string }` when the value is malformed.
 */
function parseNonNegativeInt(
  raw: unknown,
  name: string,
): { value: number | undefined; error?: string } {
  if (raw === undefined) return { value: undefined };
  const parsed = parseInt(String(raw), 10);
  if (isNaN(parsed) || parsed < 0) {
    return { value: undefined, error: `Invalid ${name}` };
  }
  return { value: parsed };
}

// ─── Handler Factory ──────────────────────────────────────────────────────────

/**
 * @title createPayoutsHandlers
 * @dev Factory that returns Express request handlers for payout operations.
 *
 * Security assumptions:
 * - The upstream `verifyJWT` middleware has already populated `req.user`
 *   with `{ id, role }`.  If `req.user` is missing or has no `id`, the
 *   handler rejects with 401.
 * - Only users with `role === 'investor'` may list their own payouts (403
 *   otherwise).  This prevents startups/issuers from enumerating investor
 *   data.
 * - All query parameters are validated before use.  Unknown status values,
 *   non-numeric pagination values, and invalid sort fields are rejected
 *   with 400 — the repository is never called with invalid inputs.
 * - The `limit` is capped at `MAX_LIMIT` to prevent clients from fetching
 *   the entire table in one request.
 * - The investor id passed to the repository is always taken from
 *   `req.user.id` (the authenticated token), never from query parameters,
 *   preventing IDOR enumeration.
 * - Filtering, sorting, and pagination are performed in SQL by the
 *   repository (using parameterised queries and a whitelisted ORDER BY
 *   column), not in JavaScript — response time and memory are constant
 *   regardless of an investor's total payout history.
 *
 * @param payoutRepo  Repository providing investor payout data.
 */
export function createPayoutsHandlers(payoutRepo: PayoutRepo) {
  /**
   * @title listPayouts
   * @dev GET handler — returns the authenticated investor's payouts with
   *      optional filters, sorting, and pagination.
   *
   * All filtering, sorting, and pagination are delegated to the repository
   * layer (SQL LIMIT / OFFSET, parameterised WHERE, whitelisted ORDER BY).
   * The handler performs no in-memory filtering, sorting, or slicing.
   *
   * Query parameters:
   *   status    — filter by payout status (pending | processed | failed)
   *   minAmount — filter payouts with amount >= minAmount (SQL NUMERIC)
   *   maxAmount — filter payouts with amount <= maxAmount (SQL NUMERIC)
   *   from      — filter payouts created on or after this ISO-8601 date
   *   to        — filter payouts created on or before this ISO-8601 date
   *   sortBy    — column to sort by (created_at | amount | status)
   *   sortOrder — sort direction (asc | desc, default desc)
   *   limit     — page size (default 20, max 100)
   *   offset    — number of records to skip (default 0)
   */
  async function listPayouts(req: Request, res: Response, next: NextFunction) {
    try {
      // ── Auth guard ──────────────────────────────────────────────────────
      const user = (req as any).user;
      if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' });
      if (user.role !== 'investor') return res.status(403).json({ error: 'Forbidden' });

      // ── Parse & validate status ─────────────────────────────────────────
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status !== undefined && !VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: 'Invalid status. Allowed: pending, processed, failed' });
      }

      // ── Parse & validate pagination ─────────────────────────────────────
      const limitResult = parseNonNegativeInt(req.query.limit, 'limit');
      if (limitResult.error) return res.status(400).json({ error: limitResult.error });

      const offsetResult = parseNonNegativeInt(req.query.offset, 'offset');
      if (offsetResult.error) return res.status(400).json({ error: offsetResult.error });

      // Cap limit at MAX_LIMIT; fall back to DEFAULT_LIMIT when omitted.
      const limit = Math.min(limitResult.value ?? DEFAULT_LIMIT, MAX_LIMIT);
      const offset = offsetResult.value ?? 0;

      // ── Parse & validate amount filters ─────────────────────────────────
      const minAmountRaw = typeof req.query.minAmount === 'string' ? req.query.minAmount : undefined;
      const maxAmountRaw = typeof req.query.maxAmount === 'string' ? req.query.maxAmount : undefined;

      let minAmount: number | undefined;
      let maxAmount: number | undefined;

      if (minAmountRaw !== undefined) {
        minAmount = parseFloat(minAmountRaw);
        if (isNaN(minAmount) || minAmount < 0) {
          return res.status(400).json({ error: 'Invalid minAmount' });
        }
      }
      if (maxAmountRaw !== undefined) {
        maxAmount = parseFloat(maxAmountRaw);
        if (isNaN(maxAmount) || maxAmount < 0) {
          return res.status(400).json({ error: 'Invalid maxAmount' });
        }
      }

      // ── Parse & validate date filters ───────────────────────────────────
      const fromRaw = typeof req.query.from === 'string' ? req.query.from : undefined;
      const toRaw = typeof req.query.to === 'string' ? req.query.to : undefined;

      let fromDate: Date | undefined;
      let toDate: Date | undefined;

      if (fromRaw !== undefined) {
        fromDate = new Date(fromRaw);
        if (isNaN(fromDate.getTime())) {
          return res.status(400).json({ error: 'Invalid from date' });
        }
      }
      if (toRaw !== undefined) {
        toDate = new Date(toRaw);
        if (isNaN(toDate.getTime())) {
          return res.status(400).json({ error: 'Invalid to date' });
        }
      }

      // ── Parse & validate sorting ────────────────────────────────────────
      const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'created_at';
      const sortOrder = typeof req.query.sortOrder === 'string' ? req.query.sortOrder : 'desc';

      if (!VALID_SORT_FIELDS.has(sortBy)) {
        return res.status(400).json({ error: 'Invalid sortBy. Allowed: created_at, amount, status' });
      }
      if (!VALID_SORT_ORDERS.has(sortOrder)) {
        return res.status(400).json({ error: 'Invalid sortOrder. Allowed: asc, desc' });
      }

      // ── Delegate everything to the repository ───────────────────────────
      // The investor id is always sourced from the authenticated token, never
      // from query parameters, to prevent IDOR enumeration attacks.
      const { payouts, total } = await payoutRepo.searchPayoutsByInvestor({
        investorId: user.id,
        status: status as 'pending' | 'processed' | 'failed' | undefined,
        minAmount,
        maxAmount,
        from: fromDate,
        to: toDate,
        sortBy: sortBy as 'created_at' | 'amount' | 'status',
        sortOrder: sortOrder as 'asc' | 'desc',
        limit,
        offset,
      });

      const hasMore = offset + limit < total;

      // ── Respond ─────────────────────────────────────────────────────────
      const body: PayoutListResponse = { payouts, total, limit, offset, hasMore };
      return res.json(body);
    } catch (err) {
      return next(err);
    }
  }

  return { listPayouts };
}

// ─── Router Factory ───────────────────────────────────────────────────────────

/**
 * @title createPayoutsRouter
 * @dev Creates an Express Router exposing payout endpoints.
 *
 * @param opts.payoutRepo  Repository used to retrieve payouts.
 * @param opts.verifyJWT   Middleware that populates `req.user`.
 */
export default function createPayoutsRouter(opts: {
  payoutRepo: PayoutRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createPayoutsHandlers(opts.payoutRepo);

  router.get('/api/investments/payouts', opts.verifyJWT, handlers.listPayouts);

  return router;
}
