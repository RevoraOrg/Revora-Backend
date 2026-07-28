import express, { Request, Response, NextFunction, Router } from 'express';
import { ZodError } from 'zod';
import { Errors } from '../lib/errors';
import { ContractUpgradeOrchestratorService } from '../services/contractUpgradeOrchestratorService';
import { StorageDriftReportService } from '../services/storageDriftReportService';
import { requireAdmin } from '../middleware/auth';

export function createContractUpgradeRouter(
  contractUpgradeOrchestratorService: ContractUpgradeOrchestratorService,
  storageDriftReportService?: StorageDriftReportService,
): Router {
  const router = express.Router();

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

  // ── Storage-layout drift report (dry-run) ────────────────────────────────

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
