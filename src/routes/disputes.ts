import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { Pool } from 'pg';
import { DisputeSLAService } from '../services/disputeSLAService';
import { NotificationRepository } from '../db/repositories/notificationRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { DISPUTE_STATES, DISPUTE_JURISDICTIONS } from '../config/disputeSLAConfig';
import { DisputeRefundService } from '../services/disputeRefundService';

/**
 * Dispute SLA Routes
 *
 * Provides endpoints for:
 * - Starting SLA timers
 * - Transitioning dispute states
 * - Pausing/resuming SLA timers
 * - Exporting weekly SLA burn report as CSV
 *
 * Security assumptions:
 * - All endpoints require authentication (auth middleware must be applied upstream)
 * - Jurisdiction and state values are validated against allowed lists
 * - CSV export is signed/authenticated by the requesting user
 */

/**
 * Validate a string against an allowed list.
 */
function validateEnum(
  value: unknown,
  allowed: readonly string[],
  fieldName: string,
): string | null {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${fieldName} must be one of: ${allowed.join(', ')}`;
  }
  return null;
}

/**
 * Validate a date string.
 */
function validateDate(value: unknown, fieldName: string): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Create dispute SLA route handlers.
 */
export function createDisputeSLAHandlers(
  disputeSLAService: DisputeSLAService,
  disputeRefundService?: DisputeRefundService
) {
  /**
   * POST /api/v1/disputes/:disputeId/sla/start
   * Start an SLA timer for a dispute.
   */
  async function startSLA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { disputeId } = req.params;
      const { jurisdiction, state, assignedUserId } = req.body || {};

      if (!disputeId) {
        res.status(400).json({ error: 'disputeId path parameter is required' });
        return;
      }

      const jurisError = validateEnum(jurisdiction, DISPUTE_JURISDICTIONS, 'jurisdiction');
      if (jurisError) {
        res.status(400).json({ error: jurisError });
        return;
      }

      const stateError = validateEnum(state, DISPUTE_STATES, 'state');
      if (stateError) {
        res.status(400).json({ error: stateError });
        return;
      }

      const record = await disputeSLAService.startTimer({
        disputeId,
        jurisdiction,
        state,
        assignedUserId: assignedUserId ?? null,
      });

      res.status(201).json({ sla: record });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/disputes/:disputeId/sla/transition
   * Transition a dispute to a new state, updating the SLA timer.
   */
  async function transitionSLA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { disputeId } = req.params;
      const { newState, newJurisdiction } = req.body || {};

      if (!disputeId) {
        res.status(400).json({ error: 'disputeId path parameter is required' });
        return;
      }

      const stateError = validateEnum(newState, DISPUTE_STATES, 'newState');
      if (stateError) {
        res.status(400).json({ error: stateError });
        return;
      }

      if (newJurisdiction !== undefined) {
        const jurisError = validateEnum(newJurisdiction, DISPUTE_JURISDICTIONS, 'newJurisdiction');
        if (jurisError) {
          res.status(400).json({ error: jurisError });
          return;
        }
      }

      const record = await disputeSLAService.transitionState({
        disputeId,
        newState,
        newJurisdiction,
      });

      res.json({ sla: record });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/disputes/:disputeId/sla/pause
   * Pause the SLA timer for a dispute.
   */
  async function pauseSLA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { disputeId } = req.params;

      if (!disputeId) {
        res.status(400).json({ error: 'disputeId path parameter is required' });
        return;
      }

      const record = await disputeSLAService.pauseTimer(disputeId);
      res.json({ sla: record });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/disputes/:disputeId/sla/resume
   * Resume a paused SLA timer.
   */
  async function resumeSLA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { disputeId } = req.params;

      if (!disputeId) {
        res.status(400).json({ error: 'disputeId path parameter is required' });
        return;
      }

      const record = await disputeSLAService.resumeTimer(disputeId);
      res.json({ sla: record });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/disputes/sla/report
   * Export SLA burn report as CSV.
   *
   * Query parameters:
   * - startDate: ISO date string (required)
   * - endDate: ISO date string (required)
   * - jurisdiction: Optional jurisdiction filter
   */
  async function exportBurnReport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { startDate, endDate, jurisdiction } = req.query;

      const start = validateDate(startDate, 'startDate');
      if (!start) {
        res.status(400).json({ error: 'startDate query parameter is required and must be a valid ISO date' });
        return;
      }

      const end = validateDate(endDate, 'endDate');
      if (!end) {
        res.status(400).json({ error: 'endDate query parameter is required and must be a valid ISO date' });
        return;
      }

      if (start >= end) {
        res.status(400).json({ error: 'startDate must be before endDate' });
        return;
      }

      if (jurisdiction !== undefined && typeof jurisdiction === 'string') {
        const jurisError = validateEnum(jurisdiction, DISPUTE_JURISDICTIONS, 'jurisdiction');
        if (jurisError) {
          res.status(400).json({ error: jurisError });
          return;
        }
      }

      const { csv, filename, rowCount } = await disputeSLAService.exportBurnReportCSV({
        startDate: start,
        endDate: end,
        jurisdiction: typeof jurisdiction === 'string' ? jurisdiction : undefined,
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Prevent caching of sensitive reports
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('X-Row-Count', String(rowCount));

      res.status(200).send(csv);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/disputes/:disputeId/refund
   * Process a partial refund for a dispute.
   */
  async function processRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { disputeId } = req.params;
      const { amount, originalDisbursement, reason, ledgerEventId, distributionId } = req.body || {};

      if (!disputeId) {
        res.status(400).json({ error: 'disputeId path parameter is required' });
        return;
      }

      if (!amount || !originalDisbursement) {
        res.status(400).json({ error: 'amount and originalDisbursement are required in body' });
        return;
      }

      if (!disputeRefundService) {
        res.status(500).json({ error: 'DisputeRefundService is not initialized' });
        return;
      }

      const refund = await disputeRefundService.processPartialRefund({
        disputeId,
        amount: String(amount),
        originalDisbursement: String(originalDisbursement),
        reason,
        ledgerEventId,
        distributionId,
      });

      res.status(201).json({ refund });
    } catch (err) {
      next(err);
    }
  }

  return {
    startSLA,
    transitionSLA,
    pauseSLA,
    resumeSLA,
    exportBurnReport,
    processRefund,
  };
}

/**
 * Dependencies for the dispute SLA router.
 */
export interface CreateDisputeSLARouterDeps {
  db: Pool;
  notificationRepo: NotificationRepository;
  auditLogRepo: AuditLogRepository;
  requireAuth: RequestHandler;
}

/**
 * Create an Express router for dispute SLA endpoints.
 */
export function createDisputeSLARouter(deps: CreateDisputeSLARouterDeps): Router {
  const router = Router();

  const disputeSLAService = new DisputeSLAService({
    db: deps.db,
    notificationRepo: deps.notificationRepo,
    auditLogRepo: deps.auditLogRepo,
  });

  const disputeRefundService = new DisputeRefundService(deps.db);

  const handlers = createDisputeSLAHandlers(disputeSLAService, disputeRefundService);

  // All dispute SLA endpoints require authentication
  router.post('/disputes/:disputeId/sla/start', deps.requireAuth, handlers.startSLA);
  router.post('/disputes/:disputeId/sla/transition', deps.requireAuth, handlers.transitionSLA);
  router.post('/disputes/:disputeId/sla/pause', deps.requireAuth, handlers.pauseSLA);
  router.post('/disputes/:disputeId/sla/resume', deps.requireAuth, handlers.resumeSLA);
  
  // Partial refund endpoint
  router.post('/disputes/:disputeId/refund', deps.requireAuth, handlers.processRefund);

  // SLA burn report (auth required)
  router.get('/disputes/sla/report', deps.requireAuth, handlers.exportBurnReport);

  return router;
}
