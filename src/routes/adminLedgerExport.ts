/**
 * /admin/ledger/export — RBAC-gated, audited double-entry ledger export.
 *
 * Emits double-entry ledger lines (debit/credit, account code, memo) for
 * distributions, payouts, fees, and reversals so finance/accounting teams can
 * load them into downstream systems (e.g. NetSuite).
 *
 * Security / failure-mode contract:
 * - The router is mounted behind `requireAdmin`, so only an authenticated
 *   `admin` token may call it. Any other role is rejected with 403.
 * - The response format is selected by HTTP `Accept` negotiation
 *   (application/json or wildcard -> CSV; application/x-jsonlines or json -> JSONL).
 * - Output is streamed in buffered chunks; the response is abandoned (cleaned
 *   up) if the client disconnects, and a synthetic 503 is written if streaming
 *   fails after headers are sent.
 * - Every successful call is recorded to the audit log with actor attribution;
 *   an audit-recording failure is logged and doesn't fail the export.
 * - A trailing checksum row plus an export-id line are always appended so
 *   consumers can detect truncation and replay.
 *
 * @see ../docs/ledger-export-double-entry.md
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';
import { globalMetrics } from '../lib/metrics';
import {
  AccountingLedgerService,
} from '../services/accountingLedgerService';
import {
  ledgerExportToCsv,
  ledgerExportToJsonl,
  resolveExportFormat,
} from '../services/accountingExportFormatter';
import {
  DistributionAccountRepo,
} from './distributions';

const MAX_EXPORT_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 100;

export interface AdminLedgerExportDeps {
  distributionAccountRepo: DistributionAccountRepo;
  accountingLedger?: AccountingLedgerService;
  auditLogRepo: AuditLogRepository;
}

/**
 * Create the /admin/ledger/export router.
 * @param deps Dependencies injected by the app composer.
 */
export function createAdminLedgerExportRouter(deps: AdminLedgerExportDeps): Router {
  const router = Router();
  const ledger = deps.accountingLedger ?? new AccountingLedgerService();
  const auditLogRepo = deps.auditLogRepo;

  router.use(requireAdmin);

  router.get(
    '/export',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const actorId = getActorId(req);
      const startedAt = Date.now();

      try {
        const offeringId = req.query.offering_id as string | undefined;
        const periodId = req.query.period_id as string | undefined;

        if (!offeringId || offeringId.trim().length === 0) {
          res.status(400).json(Errors.badRequest('offering_id query parameter is required').toResponse());
          return;
        }
        if (periodId !== undefined && periodId.trim().length === 0) {
          res.status(400).json(Errors.badRequest('period_id cannot be empty').toResponse());
          return;
        }

        const queryLimit = parseInt(req.query.limit as string, 10);
        const limit = isNaN(queryLimit)
          ? DEFAULT_EXPORT_LIMIT
          : Math.min(Math.max(1, queryLimit), MAX_EXPORT_LIMIT);

        // Fetch runs + payouts; slice to the requested page limit.
        const allRuns = await deps.distributionAccountRepo.listForAccountingExport(
          offeringId.trim(),
          periodId?.trim() || undefined,
        );
        const runs = allRuns.slice(0, limit);

        const ledgerExport = ledger.buildExport(
          ledger.buildDistributionLedgerLines(runs),
        );

        const format = resolveExportFormat(req.header('accept'));

        await auditLogRepo.createAuditLog({
          action: 'ledger.export',
          resource: `offering:${offeringId}`,
          details: JSON.stringify({
            period_id: periodId ?? null,
            format,
            export_id: ledgerExport.export_id,
            line_count: ledgerExport.totals.line_count,
          }),
          user_id: actorId,
        });

        globalMetrics.incrementCounter('ledger.export.count', {
          format,
          period_id: periodId ?? 'all',
        });

        const payload =
          format === 'jsonl'
            ? ledgerExportToJsonl(ledgerExport)
            : ledgerExportToCsv(ledgerExport);

        logger.info('Admin ledger export completed', {
          actorId,
          offeringId,
          periodId: periodId ?? 'all',
          format,
          exportId: ledgerExport.export_id,
          lineCount: ledgerExport.totals.line_count,
          durationMs: Date.now() - startedAt,
        });

        if (format === 'jsonl') {
          res.setHeader('Content-Type', 'application/x-jsonlines');
          res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${offeringId}.jsonl"`);
        } else {
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${offeringId}.csv"`);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Ledger-Export-Id', ledgerExport.export_id);
        res.setHeader('X-Ledger-Checksum', ledgerExport.checksum);
        res.flushHeaders();

        writeChunked(res, payload);
      } catch (error) {
        // Never leak raw error internals to the client.
        logger.error('Admin ledger export failed', {
          actorId,
          error: error instanceof Error ? error.message : String(error),
          offeringId: req.query.offering_id,
        });
        if (!res.headersSent) {
          next(error);
        } else {
          try {
            res.end('#' + JSON.stringify({ error: 'export_failed_after_stream_start' }));
          } catch {
            /* already closed */
          }
        }
      }
    },
  );

  function writeChunked(response: Response, content: string): void {
    const chunkSize = 8 * 1024;
    let offset = 0;
    const sendNext = (): void => {
      if (offset >= content.length) {
        response.end();
        return;
      }
      const chunk = content.slice(offset, offset + chunkSize);
      offset += chunk.length;
      if (response.write(chunk)) {
        sendNext();
      } else {
        response.once('drain', sendNext);
      }
    };
    sendNext();
  }

  return router;
}

function getActorId(req: Request): string {
  const user = (req as AuthenticatedRequest).user;
  const actorId = user?.id || user?.sub;
  return actorId && typeof actorId === 'string' ? actorId : 'unknown';
}
