import { Router, Request, Response, NextFunction } from 'express';
import { validateZodBody, validateZodParams } from '../middleware/validate';
import { z } from 'zod';
import { LedgerService } from '../services/ledgerService';
import { AppError, Errors } from '../lib/errors';
import { Logger } from '../lib/logger';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { MetricsCollector } from '../lib/metrics';

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
        const securityContext = (req as any).securityContext || req.user;

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
        const securityContext = (req as any).securityContext || req.user;

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

  return router;
}
