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
import { SecurityAuditRepository, AuditEvent } from '../security/types';

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

  return { triggerDistribution, previewDistribution, pauseDistribution, resumeDistribution };
}

export default function createDistributionsRouter(opts: {
  distributionEngine: any;
  offeringRepo?: OfferingRepo;
  verifyJWT: express.RequestHandler;
  distributionStateManager?: DistributionStateManager;
  auditRepository?: SecurityAuditRepository;
}) {
  const router = express.Router();
  const handlers = createDistributionHandlers(
    opts.distributionEngine,
    opts.offeringRepo,
    opts.distributionStateManager,
    opts.auditRepository,
  );

  router.post('/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);
  router.post('/offerings/:id/distribute/preview', opts.verifyJWT, handlers.previewDistribution);
  router.post('/distributions/:id/pause', opts.verifyJWT, handlers.pauseDistribution);
  router.post('/distributions/:id/resume', opts.verifyJWT, handlers.resumeDistribution);

  return router;
}
