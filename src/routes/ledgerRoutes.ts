import { Router, Request, Response, NextFunction } from 'express';
import { validateZodBody, validateZodParams } from '../middleware/validate';
import { z } from 'zod';
import { LedgerService } from '../services/ledgerService';
import { AppError, Errors } from '../lib/errors';
import { Logger } from '../lib/logger';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { MetricsCollector } from '../lib/metrics';
import { Readable, pipeline } from 'stream';
import Cursor from 'pg-cursor';
import { pool } from '../db/pool';

/**
 * @title Ledger Routes
 * @notice Defines API endpoints for monthly ledger close operations with dual-control authorization.
 * @dev These routes handle period close initiation and confirmation, enforcing:
 *      - Dual-control: different actors for initiation and confirmation
 *      - Atomic locking: prevents concurrent writes during close
 *      - Deterministic export: reproducible hash for idempotency
 *      - Tamper-evidence: HMAC-signed export hash
 *
 * Security Assumptions:
 * - User authentication (JWT) is verified upstream via middleware
 * - User ID is injected into securityContext by auth middleware
 * - Offering access control is verified upstream (only issuer/admin can close their offering's periods)
 * - Dual-control constraint is enforced at the service and database level
 */

// Regex for UUID v4 format
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Period ID: alphanumeric + dash/underscore (e.g., "2024-01", "Q1-2024")
const PERIOD_ID_REGEX = /^[a-zA-Z0-9_-]{1,50}$/;

// Path params schema: offering ID and period ID
const ledgerCloseParamsSchema = z.object({
  offeringId: z.string().regex(UUID_V4_REGEX, 'Invalid offering UUID'),
  periodId: z.string().regex(PERIOD_ID_REGEX, 'Invalid period ID format'),
});

/**
 * Request body is empty for both initiate and confirm endpoints.
 * Actor is extracted from authenticated securityContext.
 */
const emptyBodySchema = z.object({}).strict();

export interface AuthenticatedSecurityContext {
  user: {
    id: string;
    role: string;
  };
  requestId: string;
  ipAddress: string;
  userAgent: string;
}

interface AuthenticatedRequest extends Request {
  securityContext?: AuthenticatedSecurityContext;
}

export function createLedgerRoutes(
  ledgerService: LedgerService,
  auditLogRepo: AuditLogRepository,
  metricsCollector: MetricsCollector,
  logger: Logger
): Router {
  const router = Router();

  /**
   * POST /ledger/close/:offeringId/initiate/:periodId
   * Initiates a period close (first step of dual-control).
   * Creates a lock in 'initiated' status awaiting confirmation by different actor.
   *
   * Request: empty body
   * Response:
   * - 201: Lock created with initiation details
   * - 400: Invalid input
   * - 403: Unauthorized (not offering owner/admin)
   * - 409: Period already locked or close already initiated
   */
  router.post(
    '/close/:offeringId/initiate/:periodId',
    validateZodParams(ledgerCloseParamsSchema),
    validateZodBody(emptyBodySchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const requestId = req.requestId || (req as any).id || 'unknown';
      const startTime = Date.now();

      try {
        const { offeringId, periodId } = req.params;
        const securityContext = (req as any).securityContext || (req as any).user;

        if (!securityContext?.id) {
          throw Errors.unauthorized('User authentication required');
        }

        const initiatorId = securityContext.id;

        logger.info('POST /ledger/close/:offeringId/initiate/:periodId', {
          requestId,
          offeringId,
          periodId,
          initiatorId,
        });

        // Initiate period close
        const response = await ledgerService.initiatePeriodClose(
          offeringId,
          periodId,
          initiatorId
        );

        // Record audit event for initiation
        await auditLogRepo.createAuditLog({
          user_id: initiatorId,
          action: 'ledger_close_initiated',
          resource: `offering:${offeringId}/period:${periodId}`,
          details: JSON.stringify({
            lock_id: response.lock_id,
            message: 'Ledger period close initiated, awaiting confirmation',
          }),
          ip_address: securityContext.ipAddress || req.ip || undefined,
          user_agent: securityContext.userAgent || req.get('user-agent') || undefined,
        });

        // Record metric
        metricsCollector.incrementCounter(
          'ledger_close_initiated_total',
          { offering_id: offeringId },
          1,
          'Total ledger close initiations'
        );

        metricsCollector.recordHistogram(
          'ledger_close_initiate_duration_ms',
          Date.now() - startTime,
          { offering_id: offeringId },
          'Duration of ledger close initiation'
        );

        res.status(201).json(response);
      } catch (error) {
        logger.error('Error initiating ledger close', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          offeringId: req.params?.offeringId,
          periodId: req.params?.periodId,
        });

        metricsCollector.incrementCounter(
          'ledger_close_initiate_errors_total',
          {
            offering_id: req.params?.offeringId || 'unknown',
            error_type: error instanceof AppError ? error.code : 'internal_error',
          },
          1,
          'Total ledger close initiation errors'
        );

        next(error);
      }
    }
  );

  /**
   * POST /ledger/close/:offeringId/confirm/:periodId
   * Confirms a period close (second step of dual-control).
   * Atomically materializes export, computes hash/signature, and locks the period.
   *
   * Request: empty body
   * Response:
   * - 200: Lock confirmed with export hash and signature
   * - 400: Invalid input
   * - 403: Unauthorized or self-confirmation attempt (dual-control violation)
   * - 404: No initiated close found for this period
   * - 409: Period already locked or close not in initiated state
   */
  router.post(
    '/close/:offeringId/confirm/:periodId',
    validateZodParams(ledgerCloseParamsSchema),
    validateZodBody(emptyBodySchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const requestId = req.requestId || (req as any).id || 'unknown';
      const startTime = Date.now();

      try {
        const { offeringId, periodId } = req.params;
        const securityContext = (req as any).securityContext || (req as any).user;

        if (!securityContext?.id) {
          throw Errors.unauthorized('User authentication required');
        }

        const confirmerId = securityContext.id;

        logger.info('POST /ledger/close/:offeringId/confirm/:periodId', {
          requestId,
          offeringId,
          periodId,
          confirmerId,
        });

        // Confirm period close (atomically materializes export and locks)
        const response = await ledgerService.confirmPeriodClose(
          offeringId,
          periodId,
          confirmerId
        );

        // Record audit event for confirmation (with both actors)
        await auditLogRepo.createAuditLog({
          user_id: confirmerId,
          action: 'ledger_close_confirmed',
          resource: `offering:${offeringId}/period:${periodId}`,
          details: JSON.stringify({
            lock_id: response.lock_id,
            initiated_by: response.initiated_by,
            confirmed_by: response.confirmed_by,
            entry_count: response.entry_count,
            export_hash: response.export_hash,
            message: 'Ledger period successfully locked',
          }),
          ip_address: securityContext.ipAddress || req.ip || undefined,
          user_agent: securityContext.userAgent || req.get('user-agent') || undefined,
        });

        // Record metric
        metricsCollector.incrementCounter(
          'ledger_close_confirmed_total',
          { offering_id: offeringId },
          1,
          'Total ledger close confirmations'
        );

        metricsCollector.recordHistogram(
          'ledger_close_confirm_duration_ms',
          Date.now() - startTime,
          { offering_id: offeringId },
          'Duration of ledger close confirmation'
        );

        metricsCollector.setGauge(
          'ledger_export_entry_count',
          response.entry_count,
          { offering_id: offeringId, period_id: periodId },
          'Number of entries in locked period export'
        );

        res.status(200).json(response);
      } catch (error) {
        logger.error('Error confirming ledger close', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          offeringId: req.params?.offeringId,
          periodId: req.params?.periodId,
        });

        metricsCollector.incrementCounter(
          'ledger_close_confirm_errors_total',
          {
            offering_id: req.params?.offeringId || 'unknown',
            error_type: error instanceof AppError ? error.code : 'internal_error',
          },
          1,
          'Total ledger close confirmation errors'
        );

        next(error);
      }
    }
  );

  /**
   * GET /ledger/close/:offeringId/status/:periodId
   * Get status of a period close (for re-close idempotency and verification).
   * If already locked, returns stored hash and signature without re-materializing.
   *
   * Response:
   * - 200: Status with lock metadata if locked, or initiation state
   * - 400: Invalid input
   * - 404: No close operation found for this period
   */
  router.get(
    '/close/:offeringId/status/:periodId',
    validateZodParams(ledgerCloseParamsSchema),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const requestId = req.requestId || (req as any).id || 'unknown';

      try {
        const { offeringId, periodId } = req.params;

        logger.info('GET /ledger/close/:offeringId/status/:periodId', {
          requestId,
          offeringId,
          periodId,
        });

        // Check if period is locked and get metadata
        const metadata = await ledgerService.getLockedPeriodMetadata(
          offeringId,
          periodId
        );

        if (!metadata) {
          throw Errors.notFound(
            `No close found for period ${periodId} in offering ${offeringId}`
          );
        }

        res.status(200).json({
          offering_id: offeringId,
          period_id: periodId,
          status: 'locked',
          ...metadata,
          message: 'Period is locked. Export can be verified using export_hash and export_signature.',
        });
      } catch (error) {
        logger.error('Error getting ledger close status', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
          offeringId: req.params?.offeringId,
          periodId: req.params?.periodId,
        });

        next(error);
      }
    }
  );

  /**
   * GET /ledger/export.jsonl
   * Streams ledger export in chunked JSON-Lines format.
   * Query parameters:
   * - offeringId: UUID (required)
   * - year: YYYY (optional)
   * - periodId: string (optional)
   */
  router.get(
    '/export.jsonl',
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const requestId = req.requestId || (req as any).id || 'unknown';

      try {
        const queryParsed = ledgerExportQuerySchema.safeParse(req.query);
        if (!queryParsed.success) {
          throw Errors.validationError(
            'Invalid request parameters',
            queryParsed.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`)
          );
        }

        const { offeringId, year, periodId } = queryParsed.data;
        const securityContext = (req as any).securityContext || (req as any).user;

        if (!securityContext?.id) {
          throw Errors.unauthorized('User authentication required');
        }

        logger.info('GET /ledger/export.jsonl', {
          requestId,
          offeringId,
          year,
          periodId,
        });

        // Enforce back-pressure: get pool client
        const client = await pool.connect();

        try {
          // Build query dynamically
          let queryText = `
            SELECT id, offering_id, period_id, amount, issuer_id, reported_at, created_at
            FROM revenue_reports
            WHERE offering_id = $1
          `;
          const values: any[] = [offeringId];

          if (year) {
            const startYear = `${year}-01-01T00:00:00Z`;
            const endYear = `${parseInt(year) + 1}-01-01T00:00:00Z`;
            const pattern = `${year}-%`;
            queryText += ` AND (
              (period_start >= $2 AND period_start < $3)
              OR (period_id LIKE $4)
            )`;
            values.push(startYear, endYear, pattern);
          } else if (periodId) {
            let dateParam = periodId;
            if (/^\d{4}-\d{2}$/.test(periodId)) {
              dateParam = `${periodId}-01`;
            }
            queryText += ` AND (period_id = $2 OR (
              period_id IS NULL 
              AND DATE_TRUNC('month', period_start)::DATE = DATE_TRUNC('month', $3::DATE)::DATE
            ))`;
            values.push(periodId, dateParam);
          }

          queryText += ` ORDER BY created_at ASC, id ASC`;

          // Get count estimate first
          const countQueryText = `SELECT COUNT(*) FROM (${queryText}) as temp`;
          const countRes = await client.query(countQueryText, values);
          const countEstimate = parseInt(countRes.rows[0].count, 10);

          // Instantiate DB cursor
          const cursor = client.query(new Cursor(queryText, values));

          // Set response headers for chunked streaming
          res.setHeader('Content-Type', 'application/x-jsonlines');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Disposition', `attachment; filename="ledger-export-${offeringId}.jsonl"`);

          const stream = new LedgerExportStream({
            cursor,
            client,
            countEstimate,
            offeringId,
            year,
            periodId,
            metricsCollector,
          });

          // Connect stream to response via pipeline
          pipeline(stream, res, (err) => {
            if (err) {
              logger.error('Error in ledger export stream pipeline', {
                requestId,
                error: err.message,
              });
            } else {
              logger.info('Ledger export stream pipeline completed successfully', {
                requestId,
                offeringId,
                rowsSent: stream.getRowsSent(),
              });
            }
          });
        } catch (dbError) {
          // If we fail before setup of the pipeline, release client and propagate error
          client.release();
          throw dbError;
        }
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

// GET /ledger/export.jsonl Query Params Schema
const ledgerExportQuerySchema = z.object({
  offeringId: z.string().regex(UUID_V4_REGEX, 'Invalid offering UUID'),
  year: z.string().regex(/^\d{4}$/, 'Invalid year format').optional(),
  periodId: z.string().regex(PERIOD_ID_REGEX, 'Invalid period ID format').optional(),
});

class LedgerExportStream extends Readable {
  private cursor: Cursor;
  private client: any;
  private countEstimate: number;
  private offeringId: string;
  private year?: string;
  private periodId?: string;
  private metricsCollector: MetricsCollector;
  private sentManifest = false;
  private rowsSent = 0;
  private startTime: number;
  private batchSize = 100;
  private keepaliveInterval = 100;
  private released = false;

  constructor(options: {
    cursor: Cursor;
    client: any;
    countEstimate: number;
    offeringId: string;
    year?: string;
    periodId?: string;
    metricsCollector: MetricsCollector;
  }) {
    super({ objectMode: false });
    this.cursor = options.cursor;
    this.client = options.client;
    this.countEstimate = options.countEstimate;
    this.offeringId = options.offeringId;
    this.year = options.year;
    this.periodId = options.periodId;
    this.metricsCollector = options.metricsCollector;
    this.startTime = Date.now();
  }

  getRowsSent(): number {
    return this.rowsSent;
  }

  _read(size: number) {
    if (!this.sentManifest) {
      this.sentManifest = true;
      const manifest = {
        type: 'manifest',
        offeringId: this.offeringId,
        year: this.year,
        periodId: this.periodId,
        estimatedRowCount: this.countEstimate,
        exportedAt: new Date().toISOString(),
      };
      this.push(JSON.stringify(manifest) + '\n');
      return;
    }

    this.cursor.read(this.batchSize, (err, rows) => {
      if (err) {
        this.destroy(err);
        return;
      }

      if (!rows || rows.length === 0) {
        const duration = Date.now() - this.startTime;
        this.metricsCollector.recordHistogram(
          'export.stream.duration',
          duration,
          { offering_id: this.offeringId },
          'Duration of ledger export streams'
        );
        this.push(null);
        this.release();
        return;
      }

      let chunk = '';
      for (const row of rows) {
        const entry = {
          id: row.id,
          offering_id: row.offering_id,
          period_id: row.period_id,
          amount: row.amount,
          issuer_id: row.issuer_id,
          reported_at: row.reported_at instanceof Date ? row.reported_at.toISOString() : row.reported_at,
          created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        };

        chunk += JSON.stringify(entry) + '\n';
        this.rowsSent++;
        this.metricsCollector.incrementCounter(
          'export.stream.rows',
          { offering_id: this.offeringId },
          1,
          'Count of rows exported in ledger streams'
        );

        if (this.rowsSent % this.keepaliveInterval === 0) {
          chunk += '# keepalive\n';
        }
      }

      this.push(chunk);
    });
  }

  release() {
    if (!this.released) {
      this.released = true;
      this.cursor.close(() => {
        this.client.release();
      });
    }
  }

  _destroy(err: Error | null, callback: (err?: Error | null) => void) {
    this.release();
    callback(err);
  }
}
