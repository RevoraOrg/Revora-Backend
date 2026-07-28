import express, { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';
import { globalLogger as logger } from '../lib/logger';
import {
  assertValidScheduleTimezone,
  computeTimezoneWindow,
  formatWindowForAudit,
  findNextCronWindow,
  normalizeScheduleTimezone,
  CronSchedule,
} from '../services/distributionScheduler';
import { ALLOWED_TIMEZONES, isValidTimezone } from '../lib/timezoneAllowlist';

// ─── Types ────────────────────────────────────────────────────────────────────

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

export function createDistributionHandlers(distributionEngine: any, offeringRepo?: OfferingRepo) {
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

  /**
   * GET /offerings/:id/schedules
   * Retrieve the distribution schedule configuration for an offering.
   */
  async function getSchedule(req: Request, res: Response, next: NextFunction) {
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

      if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
        throw Errors.internal('Schedule repository not configured');
      }

      const offering = await offeringRepo.getById(offeringId);
      if (!offering) {
        throw Errors.notFound('Offering not found');
      }

      if (user.role !== 'admin') {
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      const timezone = normalizeScheduleTimezone(offering.timezone);

      const now = new Date();
      const nextWindow = findNextCronWindow(
        { expression: '0 0 * * *', timezone },
        now
      );

      return res.status(200).json({
        offering_id: offeringId,
        schedule: {
          timezone,
          allowed_timezones: [...ALLOWED_TIMEZONES],
        },
        next_scheduled_window: nextWindow
          ? {
              start: nextWindow.start.toISOString(),
              end: nextWindow.end.toISOString(),
            }
          : null,
        requestId,
      });
    } catch (err) {
      logger.error('Failed to get schedule', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  /**
   * PUT /offerings/:id/schedules/timezone
   * Update the timezone for an offering's distribution schedule.
   */
  async function updateScheduleTimezone(req: Request, res: Response, next: NextFunction) {
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

      const { timezone } = req.body;
      if (!timezone || typeof timezone !== 'string') {
        throw Errors.badRequest('Missing required field: timezone');
      }

      const normalizedTz = assertValidScheduleTimezone(timezone);

      if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
        throw Errors.internal('Schedule repository not configured');
      }

      const offering = await offeringRepo.getById(offeringId);
      if (!offering) {
        throw Errors.notFound('Offering not found');
      }

      if (user.role !== 'admin') {
        if (offering.issuer_id !== user.id) {
          throw Errors.forbidden();
        }
      }

      if (typeof offeringRepo.update === 'function') {
        await offeringRepo.update(offeringId, { timezone: normalizedTz });
      }

      // Compute a preview window in the new timezone
      const now = new Date();
      const nextWindow = findNextCronWindow(
        { expression: '0 0 * * *', timezone: normalizedTz },
        now
      );

      logger.info('Schedule timezone updated', {
        offeringId,
        timezone: normalizedTz,
        userId: user.id,
        requestId,
      });

      return res.status(200).json({
        offering_id: offeringId,
        schedule: { timezone: normalizedTz },
        next_scheduled_window: nextWindow
          ? {
              start: nextWindow.start.toISOString(),
              end: nextWindow.end.toISOString(),
            }
          : null,
        requestId,
      });
    } catch (err) {
      logger.error('Failed to update schedule timezone', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  /**
   * POST /offerings/:id/schedules/preview
   * Preview a distribution window for a given timezone and period.
   */
  async function previewScheduleWindow(req: Request, res: Response, next: NextFunction) {
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

      if (!offeringRepo || typeof offeringRepo.getById !== 'function') {
        throw Errors.internal('Schedule repository not configured');
      }

      const offering = await offeringRepo.getById(offeringId);
      if (!offering) {
        throw Errors.notFound('Offering not found');
      }

      if (user.role !== 'admin' && offering.issuer_id !== user.id) {
        throw Errors.forbidden();
      }

      const timezoneRaw = req.body?.timezone ?? offering.timezone;
      if (!timezoneRaw || typeof timezoneRaw !== 'string') {
        throw Errors.badRequest('Missing timezone parameter');
      }

      const tz = assertValidScheduleTimezone(timezoneRaw);

      const startRaw = req.body?.period?.start ?? req.body?.start;
      const endRaw = req.body?.period?.end ?? req.body?.end;
      if (!startRaw || !endRaw) {
        throw Errors.badRequest('Missing period start or end');
      }

      const periodStart = new Date(startRaw);
      const periodEnd = new Date(endRaw);
      if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
        throw Errors.badRequest('Invalid date in period');
      }

      const { window, dstTransition } = computeTimezoneWindow(
        offeringId,
        periodStart,
        periodEnd,
        tz
      );

      return res.status(200).json({
        offering_id: offeringId,
        timezone: tz,
        dst_transition: dstTransition,
        window: formatWindowForAudit(window),
        requestId,
      });
    } catch (err) {
      logger.error('Failed to preview schedule window', {
        offeringId: req.params.id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
      return next(err);
    }
  }

  return { triggerDistribution, getSchedule, updateScheduleTimezone, previewScheduleWindow };
}

export default function createDistributionsRouter(opts: {
  distributionEngine: any;
  offeringRepo?: OfferingRepo;
  verifyJWT: express.RequestHandler;
}) {
  const router = express.Router();
  const handlers = createDistributionHandlers(opts.distributionEngine, opts.offeringRepo);

  router.post('/offerings/:id/distribute', opts.verifyJWT, handlers.triggerDistribution);
  router.get('/offerings/:id/schedules', opts.verifyJWT, handlers.getSchedule);
  router.put('/offerings/:id/schedules/timezone', opts.verifyJWT, handlers.updateScheduleTimezone);
  router.post('/offerings/:id/schedules/preview', opts.verifyJWT, handlers.previewScheduleWindow);

  return router;
}
