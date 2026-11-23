import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { LedgerExportService } from '../services/ledgerExportService';
import { Errors } from '../lib/errors';

const MAX_EXPORT_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 100;

/**
 * Factory for the GL ledger export router.
 *
 * Security assumptions:
 * - `authMiddleware` is caller-supplied and verified before any route handler
 *   runs; this router never relaxes or bypasses it.
 * - Role enforcement (compliance / admin only) is the responsibility of the
 *   supplied middleware — use `requireCompliance` from src/middleware/auth.ts.
 * - `gl_account` is passed to the service layer as a plain string; the
 *   PgLedgerEntryRepository uses parameterised queries, so SQL injection via
 *   that value is not possible.
 * - Cursor values are HMAC-signed (see src/lib/pagination.ts); a tampered or
 *   cross-account cursor is rejected with 400 before hitting the database.
 *
 * @param service   Ledger export service (backed by the Postgres repository in
 *                  production, the in-memory stub in tests).
 * @param authMiddleware  One or more Express `RequestHandler`s that assert the
 *                        caller is authenticated and holds an allowed role.
 *                        Applied to every route in this router.
 */
export function createLedgerExportRouter(
  service: LedgerExportService,
  ...authMiddleware: RequestHandler[]
): Router {
  const router = Router();

  // All routes behind auth — anonymous callers receive 401, wrong role 403.
  // Guard: only call router.use when at least one middleware was provided.
  if (authMiddleware.length > 0) {
    router.use(...authMiddleware);
  }

  router.get('/export', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const glAccount = req.query.gl_account as string | undefined;
      if (!glAccount || glAccount.trim().length === 0) {
        res.status(400).json(Errors.badRequest('gl_account query parameter is required').toResponse());
        return;
      }

      const queryLimit = parseInt(req.query.limit as string, 10);
      const limit = isNaN(queryLimit)
        ? DEFAULT_EXPORT_LIMIT
        : Math.min(Math.max(1, queryLimit), MAX_EXPORT_LIMIT);

      const cursor = req.query.cursor as string | undefined;

      const result = await service.byGlAccount(glAccount.trim(), limit, cursor);

      res.status(200).json(result);
    } catch (error: unknown) {
      if (error instanceof Error && (error as any).statusCode === 400) {
        res.status(400).json(Errors.badRequest((error as Error).message).toResponse());
        return;
      }
      next(error);
    }
  });

  return router;
}
