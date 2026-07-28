import express, { Request, Response, NextFunction, Router } from 'express';
import { Errors } from '../lib/errors';
import { ContractUpgradeOrchestratorService } from '../services/contractUpgradeOrchestratorService';
import { requireAdmin } from '../middleware/auth';

export function createContractUpgradeRouter(
  contractUpgradeOrchestratorService: ContractUpgradeOrchestratorService,
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

  return router;
}
