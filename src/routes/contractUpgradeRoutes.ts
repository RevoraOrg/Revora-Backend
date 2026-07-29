import express, { Request, Response, NextFunction, Router } from 'express';
import { ZodError } from 'zod';
import { Errors } from '../lib/errors';
import {
  ContractUpgradeOrchestratorService,
  CanaryMetrics,
  CanaryMetricThresholds,
} from '../services/contractUpgradeOrchestratorService';
import { StorageDriftReportService } from '../services/storageDriftReportService';
import { requireAdmin } from '../middleware/auth';

export function createContractUpgradeRouter(
  contractUpgradeOrchestratorService: ContractUpgradeOrchestratorService,
  storageDriftReportService?: StorageDriftReportService,
): Router {
  const router = express.Router();

  // ── POST / — create upgrade proposal ──────────────────────────────────────
  router.post(
    '/',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const tenant_id = body?.tenant_id as string | undefined;
        const contract_id = body?.contract_id as string | undefined;
        const target_code_id = body?.target_code_id as string | undefined;
        const proposed_by = body?.proposed_by as string | undefined;
        const attestation = body?.attestation;

        if (!tenant_id || !contract_id || !target_code_id || !proposed_by || !attestation) {
          return next(
            Errors.badRequest(
              'tenant_id, contract_id, target_code_id, proposed_by, and attestation are required',
            ),
          );
        }

        const upgrade = await contractUpgradeOrchestratorService.createUpgrade({
          tenant_id,
          contract_id,
          target_code_id,
          proposed_by,
          attestation,
        });

        res.status(201).json({ upgrade });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── POST /:id/canary/start — activate canary phase ────────────────────────
  router.post(
    '/:id/canary/start',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const upgradeId = req.params.id;
        const body = req.body as Record<string, unknown> | undefined;
        const canary_offering_id = body?.canary_offering_id as string | undefined;
        const actor_id = body?.actor_id as string | undefined;
        const hold_period_seconds =
          body?.hold_period_seconds !== undefined
            ? Number(body.hold_period_seconds)
            : undefined;

        if (!canary_offering_id) {
          return next(Errors.badRequest('canary_offering_id is required'));
        }
        if (!actor_id) {
          return next(Errors.badRequest('actor_id is required'));
        }
        if (
          hold_period_seconds !== undefined &&
          (!Number.isInteger(hold_period_seconds) || hold_period_seconds < 0)
        ) {
          return next(Errors.badRequest('hold_period_seconds must be a non-negative integer'));
        }

        const upgrade = await contractUpgradeOrchestratorService.startCanary(upgradeId, {
          canary_offering_id,
          actor_id,
          hold_period_seconds,
        });

        res.status(200).json({ upgrade });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── POST /:id/canary/metrics — record canary metrics ──────────────────────
  router.post(
    '/:id/canary/metrics',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const upgradeId = req.params.id;
        const body = req.body as Record<string, unknown> | undefined;
        const actor_id = body?.actor_id as string | undefined;
        const metrics = body?.metrics as CanaryMetrics | undefined;
        const thresholds = body?.thresholds as CanaryMetricThresholds | undefined;

        if (!actor_id) {
          return next(Errors.badRequest('actor_id is required'));
        }
        if (
          !metrics ||
          typeof metrics.error_rate !== 'number' ||
          typeof metrics.p99_latency_ms !== 'number' ||
          typeof metrics.failed_tx_count !== 'number'
        ) {
          return next(
            Errors.badRequest(
              'metrics with numeric error_rate, p99_latency_ms, and failed_tx_count are required',
            ),
          );
        }

        const upgrade = await contractUpgradeOrchestratorService.recordCanaryMetrics(
          upgradeId,
          metrics,
          actor_id,
          thresholds,
        );

        res.status(200).json({ upgrade });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── POST /:id/canary/promote — promote to canary_passed ───────────────────
  router.post(
    '/:id/canary/promote',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const upgradeId = req.params.id;
        const body = req.body as Record<string, unknown> | undefined;
        const actor_id = body?.actor_id as string | undefined;
        const thresholds = body?.thresholds as CanaryMetricThresholds | undefined;

        if (!actor_id) {
          return next(Errors.badRequest('actor_id is required'));
        }

        const upgrade = await contractUpgradeOrchestratorService.promoteCanary(
          upgradeId,
          actor_id,
          thresholds,
        );

        res.status(200).json({ upgrade });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── POST /:id/canary/rollback — explicit canary rollback ──────────────────
  router.post(
    '/:id/canary/rollback',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const upgradeId = req.params.id;
        const body = req.body as Record<string, unknown> | undefined;
        const actor_id = body?.actor_id as string | undefined;
        const reason = body?.reason as string | undefined;

        if (!actor_id) {
          return next(Errors.badRequest('actor_id is required'));
        }

        const upgrade = await contractUpgradeOrchestratorService.rollbackCanary(
          upgradeId,
          actor_id,
          reason,
        );

        res.status(200).json({ upgrade });
      } catch (error) {
        next(error);
      }
    },
  );

  // ── Storage-layout drift report (dry-run) ─────────────────────────────────
  router.post(
    '/drift-report',
    requireAdmin,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!storageDriftReportService) {
          return next(
            Errors.serviceUnavailable('Storage drift report service is not initialised'),
          );
        }

        const body = req.body as Record<string, unknown> | undefined;
        const currentDescriptor = body?.current_descriptor;
        const targetDescriptor = body?.target_descriptor;
        const upgradeId = body?.upgrade_id as string | undefined;

        if (!currentDescriptor || !targetDescriptor) {
          return next(
            Errors.badRequest('current_descriptor and target_descriptor are required'),
          );
        }

        let result;
        try {
          result = await storageDriftReportService.generateReport({
            currentDescriptor,
            targetDescriptor,
            upgradeId,
          });
        } catch (err: unknown) {
          if (err instanceof ZodError) {
            return next(
              Errors.badRequest(
                `Invalid descriptor format: ${err.issues.map((i) => i.message).join('; ')}`,
              ),
            );
          }
          throw err;
        }

        const statusCode = result.report.hasBreakingChanges ? 422 : 200;

        res.status(statusCode).json({
          report: result.report,
          alert_emitted: result.alertEmitted,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
