import { Router, Request, Response, NextFunction } from 'express';
import { LedgerExportService } from '../services/ledgerExportService';
import { Errors } from '../lib/errors';

const MAX_EXPORT_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 100;

export function createLedgerExportRouter(service: LedgerExportService): Router {
  const router = Router();

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
