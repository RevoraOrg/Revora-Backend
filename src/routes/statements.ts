/**
 * Investor statement routes (Issue #874).
 *
 * GET /statements/:periodId/:investorId serves the generated statement PDF
 * only after re-verifying the persisted sha256 (the `(statement_id, sha256,
 * generated_at)` row checkpointed by the batch worker) against the stored
 * bytes. A mismatch means the artifact was tampered with or storage drifted,
 * and the request is rejected with 409 CONFLICT instead of serving untrusted
 * bytes.
 *
 * Security assumptions:
 * - Upstream `verifyJWT` middleware populates `req.user` with `{ id, role }`
 *   from a verified token; headers are never trusted for identity.
 * - Authorization: `admin`/`compliance` may fetch any statement; an
 *   `investor` may only fetch their own statement (IDOR boundary). Other
 *   roles (e.g. `startup`) are forbidden — issuers cannot enumerate investor
 *   statements.
 * - Path parameters are validated (non-empty, bounded length) before use.
 * - The persisted checksum is compared with a fresh sha256 of the bytes on
 *   every fetch; failures are logged as security-relevant events.
 */
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import { createHash } from 'crypto';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { PdfRenderJobRepository } from '../db/repositories/pdfRenderJobRepository';

const PRIVILEGED_ROLES = new Set(['admin', 'compliance']);

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

/** Keep generated filenames safe for Content-Disposition. */
function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Storage capable of reading back rendered statement bytes. */
export interface StatementReadStorage {
  getObject(storageKey: string): Promise<Buffer | null>;
}

export interface StatementDeps {
  jobRepo: Pick<PdfRenderJobRepository, 'findCompletedByInvestorAndPeriod'>;
  storage: StatementReadStorage;
  verifyJWT: RequestHandler;
}

export function createStatementHandlers(deps: {
  jobRepo: Pick<PdfRenderJobRepository, 'findCompletedByInvestorAndPeriod'>;
  storage: StatementReadStorage;
}) {
  /**
   * GET /:periodId/:investorId
   *
   * Re-verifies the persisted sha256 over the stored PDF bytes before
   * serving. Responds:
   *  - 200 + application/pdf on success, with `X-Statement-Sha256` and an
   *    `ETag` set to the verified hash
   *  - 401 when unauthenticated
   *  - 403 when the caller may not view this investor's statement
   *  - 400 for missing/oversized path parameters
   *  - 404 when no completed statement exists for (period, investor)
   *  - 409 when the recomputed hash disagrees with the persisted checksum
   */
  async function getStatement(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as unknown as { user?: { id?: string; role?: string } }).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const periodId = String(req.params.periodId ?? '');
      const investorId = String(req.params.investorId ?? '');
      if (!isNonEmptyString(periodId) || !isNonEmptyString(investorId)) {
        throw Errors.badRequest('periodId and investorId must be non-empty strings');
      }

      // ── Authorization ───────────────────────────────────────────────────
      if (!PRIVILEGED_ROLES.has(user.role ?? '')) {
        if (user.role !== 'investor' || user.id !== investorId) {
          throw Errors.forbidden(
            'Forbidden: statements are limited to the owning investor or privileged roles'
          );
        }
      }

      const job = await deps.jobRepo.findCompletedByInvestorAndPeriod(
        investorId,
        periodId
      );
      if (!job || !job.storage_key || !job.checksum) {
        throw Errors.notFound('Statement not found for this investor and period');
      }

      const bytes = await deps.storage.getObject(job.storage_key);
      if (!bytes) {
        throw Errors.notFound('Statement artifact not found in storage');
      }

      // ── Integrity re-verification before serving ────────────────────────
      const recomputed = createHash('sha256').update(bytes).digest('hex');
      if (recomputed !== job.checksum) {
        globalLogger.error('statement.tamper-detected: sha256 mismatch before serving', {
          periodId,
          investorId,
          statementId: job.id,
          expected: job.checksum,
          actual: recomputed,
          requestId: (req as unknown as { id?: string }).id,
        });
        throw Errors.conflict(
          'Statement checksum mismatch: artifact failed integrity verification'
        );
      }

      const filename = `statement-${sanitizeFilename(periodId)}-${sanitizeFilename(investorId)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('X-Statement-Sha256', recomputed);
      res.setHeader('ETag', `"${recomputed}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(bytes);
    } catch (err) {
      next(err);
    }
  }

  return { getStatement };
}

export function createStatementsRouter(opts: StatementDeps) {
  const router = express.Router();
  const handlers = createStatementHandlers(opts);

  router.get('/:periodId/:investorId', opts.verifyJWT, handlers.getStatement);

  return router;
}

export default createStatementsRouter;
