import { Router, Request, Response, NextFunction } from 'express';
import { LedgerExportService, isValidCutoffTimestamp } from '../services/ledgerExportService';
import { Errors } from '../lib/errors';

const MAX_EXPORT_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 100;

export function createLedgerExportRouter(service: LedgerExportService): Router {
  const router = Router();

  /**
   * GET /export
   * Exports ledger entries for a GL account.
   *
   * Query parameters:
   * - gl_account: string (required) - GL account identifier
   * - limit: number (optional, default: 100, max: 1000) - Maximum entries to return
   * - cursor: string (optional) - Pagination cursor for next page
   * - snapshot: string (optional, "true" or "false") - Enable snapshot mode for byte-for-byte reproducible exports
   * - cutoff_at: string (optional, ISO 8601 timestamp) - Snapshot cutoff timestamp; entries recorded after this time are excluded
   *
   * Snapshot mode:
   * - When snapshot=true, entries are deterministically sorted by (entry_date ASC, id ASC)
   * - A Content-SHA-256 header is set with the SHA-256 hash of the export
   * - The response body also includes a content_sha256 field
   * - Late-arriving events after cutoff_at are excluded and logged
   */
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

      // Parse snapshot mode
      const snapshotParam = req.query.snapshot as string | undefined;
      const snapshot = snapshotParam === 'true';

      // Parse optional cutoff_at for snapshot mode
      const cutoffAt = req.query.cutoff_at as string | undefined;

      // Validate cutoff_at if provided
      if (cutoffAt && !isValidCutoffTimestamp(cutoffAt)) {
        res.status(400).json(Errors.badRequest('Invalid cutoff_at timestamp format').toResponse());
        return;
      }

      // Validate that cutoff_at is only used with snapshot=true
      if (cutoffAt && !snapshot) {
        res.status(400).json(Errors.badRequest('cutoff_at parameter requires snapshot=true').toResponse());
        return;
      }

      const result = await service.byGlAccount(glAccount.trim(), limit, cursor, {
        snapshot,
        cutoff_at: cutoffAt,
      });

      // In snapshot mode, set Content-SHA-256 header for HTTP-level verification
      if (snapshot && result.content_sha256) {
        res.setHeader('Content-SHA-256', result.content_sha256);
        res.setHeader('X-Snapshot-Mode', 'true');
        if (cutoffAt) {
          res.setHeader('X-Snapshot-Cutoff-At', cutoffAt);
        }
      }

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
