import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { requireAdmin, AuthenticatedRequest } from '../middleware/auth';
import { UserRepository } from '../db/repositories/userRepository';
import { SecurityAuditRepository } from '../security/types';
import { createKycRiskTierService } from '../services/kycRiskTierService';
import { isKycRiskTier } from '../lib/kycRiskTierCaps';
import { AppError } from '../lib/errors';

/**
 * Admin routes for KYC risk-tier management.
 * Mount under `/admin` (requireAdmin applied here as well for safety).
 */
export function createAdminKycRiskTierRouter(
  db: Pool,
  auditRepo: SecurityAuditRepository,
): Router {
  const router = Router();
  const service = createKycRiskTierService(new UserRepository(db), auditRepo);

  router.use(requireAdmin);

  /**
   * PATCH /investors/:id/kyc-risk-tier
   * Body: { tier: 'low'|'standard'|'elevated'|'high'|'restricted', offering_cap_bps?: number|null }
   *
   * Updates the investor's KYC risk tier and emits `investor.cap.recalculated`.
   * Does not modify existing investments.
   */
  router.patch(
    '/investors/:id/kyc-risk-tier',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        if (!authReq.user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const tier = (req.body as { tier?: unknown })?.tier;
        if (!isKycRiskTier(tier)) {
          res.status(400).json({
            error: 'tier must be one of: low, standard, elevated, high, restricted',
          });
          return;
        }

        const body = req.body as { offering_cap_bps?: number | null };
        const referenceOfferingCapBps =
          body.offering_cap_bps === undefined
            ? null
            : body.offering_cap_bps;

        const result = await service.updateKycRiskTier({
          investorId: String(req.params.id),
          tier,
          actorId: String(authReq.user.id),
          referenceOfferingCapBps,
        });

        res.status(200).json({
          investor_id: result.user.id,
          previous_tier: result.previousTier,
          kyc_risk_tier: result.user.kyc_risk_tier,
          effective_cap_bps: result.resolution.effectiveCapBps,
          multiplier: result.resolution.multiplier,
          retroactive_invalidation: false,
        });
      } catch (error) {
        if (error instanceof AppError) {
          res.status(error.statusCode).json(error.toResponse());
          return;
        }
        next(error);
      }
    },
  );

  return router;
}
