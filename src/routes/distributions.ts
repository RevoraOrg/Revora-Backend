/**
 * /distributions HTTP routes — see architecture map for the request lifecycle.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 * @see ../docs/distribution-engine-safety.md
 * @see ../docs/distribution-advisory-lock.md
 */
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';
import { globalMetrics } from '../lib/metrics';
import { DistributionStateManager } from '../services/distributionScheduler';
import { ScheduledDistributionRepository } from '../db/repositories/scheduledDistributionRepository';
import { AccountingLedgerService, DistributionRunLedger } from '../services/accountingLedgerService';
import { SecurityAuditRepository, AuditEvent } from '../security/types';

/**
 * Minimal repository surface the distributions router depends on for the
 * double-entry accounting export. Defined locally to keep the router
 * decoupled from the full repository class and preserve test compatibility.
 */
export interface DistributionAccountRepo {
  listForAccountingExport(
    offeringId: string,
    periodId?: string,
  ): Promise<DistributionRunLedger[]>;
}

export interface OfferingRepo {
  getById: (id: string) => Promise<Offering | null>;
  update?: (id: string, input: Record<string, unknown>) => Promise<Offering | null>;
}

export interface Offering {
  id: string;
  issuer_id?: string;
  timezone?: string;
}

export interface ScheduleConfig {
  timezone: string;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function createDistributionHandlers(
  distributionEngine: any,
  offeringRepo?: OfferingRepo,
  distributionStateManager?: DistributionStateManager,
  auditRepository?: SecurityAuditRepository,
  distributionAccountRepo?: DistributionAccountRepo,
  accountingLedger?: AccountingLedgerService,
  scheduledDistributionRepo?: ScheduledDistributionRepository,
) {
  async function triggerDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const offeringId = String(req.params.id || '');
      if (!offeringId) {
        throw Errors.badRequest('Missing offering id');
      }

      logger.info('Triggering distribution', {
        offeringId,
        userId: user.id,
        role: user.role,
        requestId,
      });

      const revenueRaw = req.body?.revenue_amount ?? req.body?.revenueAmount;
      const revenueAmount = revenueRaw !== undefined ? Number(revenueRaw) : NaN;
      if (Number.isNaN(revenueAmount) || revenueAmount <= 0) {
        throw Errors.badRequest('Invalid revenue amount');
      }

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) {
        throw Errors.badRequest('Missing distribution period');
      }
      
      const startDate = new Date(startRaw);
      const endDate = new Date(endRaw);
      
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.badRequest('Invalid date format in distribution period');
      }
      
      if (endDate <= startDate) {
        throw Errors.badRequest('End date must be after start date');
      }
      
      const period = { start: startDate, end: endDate };

      if (user.role !== 'admin') {
        if (user.role !== 'startup') {
          throw Errors.forbidden('Forbidden: startup role required');
        }
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          throw Errors.forbidden('Forbidden: cannot verify issuer');
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const result = await distributionEngine.distribute(offeringId, period, revenueAmount);

      logger.info('Distribution triggered successfully', {
        offeringId,
        runId: result.distributionRun?.id,
        payoutCount: result.payouts?.length,
        requestId,
      });
      return res.status(200).json({
        run_id: result.distributionRun?.id,
        payouts: result.payouts,
        total_payouts: result.payouts?.length ?? 0,
        requestId,
      });
    } catch (err) {
      logger.error('Distribution trigger failed', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  async function previewDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const offeringId = String(req.params.id || '');
      if (!offeringId) {
        throw Errors.badRequest('Missing offering id');
      }

      logger.info('Requesting distribution preview', {
        offeringId,
        userId: user.id,
        role: user.role,
        requestId,
      });

      const revenueRaw = req.body?.revenue_amount ?? req.body?.revenueAmount;
      const revenueAmount = revenueRaw !== undefined ? Number(revenueRaw) : NaN;
      if (Number.isNaN(revenueAmount) || revenueAmount <= 0) {
        throw Errors.badRequest('Invalid revenue amount');
      }

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) {
        throw Errors.badRequest('Missing distribution period');
      }
      
      const startDate = new Date(startRaw);
      const endDate = new Date(endRaw);
      
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        throw Errors.badRequest('Invalid date format in distribution period');
      }
      
      if (endDate <= startDate) {
        throw Errors.badRequest('End date must be after start date');
      }
      
      // Include period.id if provided in request, generate a synthetic one for preview if not
      const periodId = req.body?.period?.id ?? `${startRaw}:${endRaw}`;
      const period = { id: periodId, start: startDate, end: endDate };

      // Authorization: same level as real distribution (admin or startup issuer of offering)
      // The data returned (per-investor projected amounts) is real and sensitive,
      // so we gate preview with the same permission level as real execution.
      if (user.role !== 'admin') {
        if (user.role !== 'startup') {
          throw Errors.forbidden('Forbidden: startup role required');
        }
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          throw Errors.forbidden('Forbidden: cannot verify issuer');
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const preview = await distributionEngine.previewRun(offeringId, period, revenueAmount);

      // Emit preview count metric
      // Labels: user_role (safe, low-cardinality), period_id (safe, part of business logic)
      // NO investor-specific data in labels (prevents high-cardinality explosion and data leakage)
      try {
        globalMetrics.incrementCounter('distribution.preview.count', {
          user_role: user.role,
          period_id: periodId,
        });
      } catch (metricsErr) {
        // Log but do not fail the preview if metrics emission fails
        logger.warn('Failed to emit distribution preview metric', {
          previewId: preview.preview_id,
          error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
        });
      }

      logger.info('Distribution preview completed successfully', {
        offeringId,
        previewId: preview.preview_id,
        investorCount: preview.investor_count,
        requestId,
      });

      return res.status(200).json(preview);
    } catch (err) {
      logger.error('Distribution preview failed', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  async function pauseDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }
      if (user.role !== 'admin') {
        throw Errors.forbidden('Forbidden: admin role required');
      }

      const distributionId = String(req.params.id || '');
      if (!distributionId) {
        throw Errors.badRequest('Missing distribution id');
      }

      const reason = req.body?.reason;
      if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
        throw Errors.badRequest('Reason is required to pause a distribution');
      }

      if (!distributionStateManager) {
        throw Errors.internal('Distribution state manager not available');
      }

      distributionStateManager.pause(distributionId, reason, user.id);

      // Emit audit event
      if (auditRepository) {
        try {
          const auditEvent: AuditEvent = {
            id: crypto.randomUUID(),
            type: 'AUTHORIZATION',
            userId: user.id,
            action: 'distribution.pause',
            resource: `distribution:${distributionId}`,
            outcome: 'SUCCESS',
            details: { reason, distributionId } as Record<string, unknown>,
            securityContext: {
              requestId,
              ipAddress: req.ip || '',
              userAgent: req.headers['user-agent'] || '',
              timestamp: new Date(),
            },
            timestamp: new Date(),
          };
          await auditRepository.record(auditEvent);
        } catch (auditErr) {
          logger.warn('Failed to record audit event for distribution pause', {
            distributionId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }

      logger.info('Distribution paused', {
        distributionId,
        reason,
        userId: user.id,
        requestId,
      });

      return res.status(200).json({
        distribution_id: distributionId,
        status: 'paused',
        reason,
        paused_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('Distribution pause failed', {
        distributionId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  async function resumeDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }
      if (user.role !== 'admin') {
        throw Errors.forbidden('Forbidden: admin role required');
      }

      const distributionId = String(req.params.id || '');
      if (!distributionId) {
        throw Errors.badRequest('Missing distribution id');
      }

      if (!distributionStateManager) {
        throw Errors.internal('Distribution state manager not available');
      }

      const record = distributionStateManager.resume(distributionId, user.id);

      if (!record) {
        logger.info('Resume called on non-paused distribution (idempotent)', {
          distributionId,
          userId: user.id,
          requestId,
        });
        return res.status(200).json({
          distribution_id: distributionId,
          status: 'active',
          message: 'Distribution was not paused; no action needed',
        });
      }

      // Emit audit event
      if (auditRepository) {
        try {
          const auditEvent: AuditEvent = {
            id: crypto.randomUUID(),
            type: 'AUTHORIZATION',
            userId: user.id,
            action: 'distribution.resume',
            resource: `distribution:${distributionId}`,
            outcome: 'SUCCESS',
            details: {
              distributionId,
              pausedAt: record.pausedAt.toISOString(),
              pausedBy: record.pausedBy,
              reason: record.reason,
            } as Record<string, unknown>,
            securityContext: {
              requestId,
              ipAddress: req.ip || '',
              userAgent: req.headers['user-agent'] || '',
              timestamp: new Date(),
            },
            timestamp: new Date(),
          };
          await auditRepository.record(auditEvent);
        } catch (auditErr) {
          logger.warn('Failed to record audit event for distribution resume', {
            distributionId,
            error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        }
      }

      logger.info('Distribution resumed', {
        distributionId,
        userId: user.id,
        requestId,
      });

      return res.status(200).json({
        distribution_id: distributionId,
        status: 'resumed',
        reason: record.reason,
        paused_at: record.pausedAt.toISOString(),
        resumed_at: record.resumedAt?.toISOString(),
      });
    } catch (err) {
      logger.error('Distribution resume failed', {
        distributionId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  /**
   * GET /offerings/:id/ledger/export
   *
   * Returns a stable, deterministic double-entry ledger of distributions and
   * payouts for the offering, together with a trailing checksum and export-id
   * for downstream accounting (e.g. NetSuite) and replay detection.
   *
   * Authorization is identical to distribution execution: an admin may export
   * any offering; a startup may only export an offering they issued.
   *
   * @dev Backed by DistributionAccountRepo.listForAccountingExport via the
   *      AccountingLedgerService. When the feature is not wired (no repo or
   *      ledger service provided) the handler returns 404 to preserve
   *      backward compatibility for existing deployers.
   */
  async function exportDistributionLedger(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      if (!user || !user.id) {
        throw Errors.unauthorized();
      }

      const offeringId = String(req.params.id || '');
      if (!offeringId) {
        throw Errors.badRequest('Missing offering id');
      }

      if (!distributionAccountRepo || !accountingLedger) {
        throw Errors.notFound('Accounting export is not available');
      }

      const periodId = req.query.period_id ? String(req.query.period_id) : undefined;
      if (periodId !== undefined && periodId.trim().length === 0) {
        throw Errors.badRequest('period_id cannot be empty');
      }

      logger.info('Requesting distribution ledger export', {
        offeringId,
        userId: user.id,
        role: user.role,
        periodId,
        requestId,
      });

      // Authorization: same level as real distribution.
      if (user.role !== 'admin') {
        if (user.role !== 'startup') {
          throw Errors.forbidden('Forbidden: startup role required');
        }
        if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
          throw Errors.forbidden('Forbidden: cannot verify issuer');
        }
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const runs = await distributionAccountRepo.listForAccountingExport(
        offeringId,
        periodId,
      );
      const ledger = accountingLedger.buildExport(
        accountingLedger.buildDistributionLedgerLines(runs),
      );

      logger.info('Distribution ledger export completed', {
        offeringId,
        exportId: ledger.export_id,
        lineCount: ledger.totals.line_count,
        requestId,
      });

      return res.status(200).json(ledger);
    } catch (err) {
      logger.error('Distribution ledger export failed', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  // ─── Deferred distribution scheduling ────────────────────────────────────────

  function requireScheduleRepo(): ScheduledDistributionRepository {
    if (!scheduledDistributionRepo) {
      throw Errors.internal('Scheduled distribution repository not available');
    }
    return scheduledDistributionRepo;
  }

  function requireScheduleAdmin(user: { id?: string; role?: string }): void {
    if (!user || !user.id) {
      throw Errors.unauthorized();
    }
    if (user.role !== 'admin') {
      throw Errors.forbidden('Forbidden: admin role required');
    }
  }

  /**
   * POST /distributions/schedule
   * Enqueues a deferred distribution run for a future settlement window.
   * Admin-only. Duplicate (offering_id, period_id) enqueue returns 409.
   */
  async function scheduleDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      requireScheduleAdmin(user);
      const repo = requireScheduleRepo();

      const offeringId = String(req.body?.offering_id ?? '');
      const periodId = String(req.body?.period_id ?? '');
      if (!offeringId) {
        throw Errors.badRequest('offering_id is required');
      }
      if (!periodId) {
        throw Errors.badRequest('period_id is required');
      }

      const runAtRaw = req.body?.run_at;
      const runAt = new Date(runAtRaw);
      if (!runAtRaw || isNaN(runAt.getTime())) {
        throw Errors.badRequest('run_at must be a valid date');
      }

      const totalRaw = req.body?.total_amount;
      const totalAmount = totalRaw !== undefined ? Number(totalRaw) : NaN;
      if (Number.isNaN(totalAmount) || totalAmount <= 0) {
        throw Errors.badRequest('total_amount must be a positive number');
      }

      let periodStart: Date | undefined;
      let periodEnd: Date | undefined;
      if (
        req.body?.period_start !== undefined ||
        req.body?.period_end !== undefined
      ) {
        periodStart = new Date(req.body.period_start);
        periodEnd = new Date(req.body.period_end);
        if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
          throw Errors.badRequest('period_start / period_end must be valid dates');
        }
        if (periodEnd <= periodStart) {
          throw Errors.badRequest('period_end must be after period_start');
        }
      }

      if (offeringRepo && typeof offeringRepo.getById === 'function') {
        const offering = await offeringRepo.getById(offeringId);
        if (!offering) {
          throw Errors.notFound('Offering not found');
        }
      }

      const scheduled = await repo.create({
        offering_id: offeringId,
        period_id: periodId,
        period_start: periodStart,
        period_end: periodEnd,
        total_amount: totalAmount,
        run_at: runAt,
        created_by: user.id,
      });

      logger.info('Scheduled distribution enqueued', {
        scheduledId: scheduled.id,
        offeringId,
        runAt: scheduled.run_at.toISOString(),
        userId: user.id,
        requestId,
      });

      return res.status(201).json({
        id: scheduled.id,
        offering_id: scheduled.offering_id,
        period_id: scheduled.period_id,
        total_amount: scheduled.total_amount,
        run_at: scheduled.run_at.toISOString(),
        status: scheduled.status,
        created_by: scheduled.created_by,
      });
    } catch (err) {
      logger.error('Schedule distribution failed', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  /**
   * GET /distributions/schedule
   * Lists deferred distribution runs (optionally filtered by offering_id).
   * Admin-only.
   */
  async function listScheduledDistributions(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      requireScheduleAdmin(user);
      const repo = requireScheduleRepo();

      const offeringId = req.query.offering_id
        ? String(req.query.offering_id)
        : undefined;
      if (offeringId !== undefined && offeringId.trim().length === 0) {
        throw Errors.badRequest('offering_id cannot be empty');
      }

      const requestedLimit = Number(req.query.limit ?? 100);
      const requestedOffset = Number(req.query.offset ?? 0);
      const limit = Number.isFinite(requestedLimit) ? Math.min(requestedLimit, 500) : 100;
      const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

      const rows = offeringId
        ? await repo.findByOffering(offeringId)
        : await repo.findAll(limit, offset);

      return res.status(200).json({
        scheduled_distributions: rows.map((row) => ({
          id: row.id,
          offering_id: row.offering_id,
          period_id: row.period_id,
          total_amount: row.total_amount,
          run_at: row.run_at.toISOString(),
          status: row.status,
          attempts: row.attempts,
          error_message: row.error_message ?? null,
          executed_at: row.executed_at ? row.executed_at.toISOString() : null,
          created_by: row.created_by ?? null,
        })),
      });
    } catch (err) {
      logger.error('List scheduled distributions failed', {
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  /**
   * DELETE /distributions/schedule/:id
   * Cancels a pending deferred distribution run. Admin-only. Only rows still
   * in `scheduled` status can be cancelled; anything else returns 404.
   */
  async function cancelScheduledDistribution(req: Request, res: Response, next: NextFunction) {
    const requestId = (req as any).id;
    try {
      const user = (req as any).user;
      requireScheduleAdmin(user);
      const repo = requireScheduleRepo();

      const scheduledId = String(req.params.id || '');
      if (!scheduledId) {
        throw Errors.badRequest('Missing scheduled distribution id');
      }

      const cancelled = await repo.markCancelled(scheduledId);
      if (!cancelled) {
        throw Errors.notFound(
          'Scheduled distribution not found or no longer cancellable',
        );
      }

      logger.info('Scheduled distribution cancelled', {
        scheduledId,
        userId: user.id,
        requestId,
      });

      return res.status(200).json({
        id: cancelled.id,
        offering_id: cancelled.offering_id,
        period_id: cancelled.period_id,
        status: cancelled.status,
      });
    } catch (err) {
      logger.error('Cancel scheduled distribution failed', {
        scheduledId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  return {
    triggerDistribution,
    previewDistribution,
    pauseDistribution,
    resumeDistribution,
    exportDistributionLedger,
    scheduleDistribution,
    listScheduledDistributions,
    cancelScheduledDistribution,
  };
}

export default function createDistributionsRouter(opts: {
  distributionEngine: any;
  offeringRepo?: OfferingRepo;
  verifyJWT: express.RequestHandler;
  distributionStateManager?: DistributionStateManager;
  auditRepository?: SecurityAuditRepository;
  distributionAccountRepo?: DistributionAccountRepo;
  accountingLedger?: AccountingLedgerService;
  scheduledDistributionRepo?: ScheduledDistributionRepository;
}) {
  const router = express.Router();
  const handlers = createDistributionHandlers(
    opts.distributionEngine,
    opts.offeringRepo,
    opts.distributionStateManager,
    opts.auditRepository,
    opts.distributionAccountRepo,
    opts.accountingLedger,
    opts.scheduledDistributionRepo,
  );

  router.post('/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);
  router.post('/offerings/:id/distribute/preview', opts.verifyJWT, handlers.previewDistribution);
  router.get('/offerings/:id/ledger/export', opts.verifyJWT, handlers.exportDistributionLedger);
  router.post('/distributions/:id/pause', opts.verifyJWT, handlers.pauseDistribution);
  router.post('/distributions/:id/resume', opts.verifyJWT, handlers.resumeDistribution);
  router.post('/distributions/schedule', opts.verifyJWT, handlers.scheduleDistribution);
  router.get('/distributions/schedule', opts.verifyJWT, handlers.listScheduledDistributions);
  router.delete('/distributions/schedule/:id', opts.verifyJWT, handlers.cancelScheduledDistribution);

  return router;
}
