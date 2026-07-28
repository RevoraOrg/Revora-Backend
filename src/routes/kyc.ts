import { Router, Request, Response, NextFunction } from 'express';
import { requireInvestor, AuthenticatedRequest } from '../middleware/auth';
import { KycRouter } from '../services/kyc/KycRouter';
import { KycApplicantInfo } from '../services/kyc/KycProvider';
import { AppError } from '../lib/errors';

export function createKycRoutes(kycRouter: KycRouter): Router {
  const router = Router();

  /**
   * POST /api/v1/kyc
   * Initiates a KYC check for the authenticated investor.
   * Uses routing based on the applicant's jurisdiction.
   */
  router.post('/', requireInvestor, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'Unauthorized: User not authenticated' });
        return;
      }
      const investorId = String(authReq.user.id);
      const info = req.body as Partial<KycApplicantInfo>;

      if (!info.address?.country) {
        res.status(400).json({ error: 'Country jurisdiction is required in address' });
        return;
      }

      const jurisdiction = info.address.country.toUpperCase();
      let provider;
      try {
        provider = kycRouter.route(jurisdiction);
      } catch (err: any) {
        res.status(403).json({ error: err.message || 'Jurisdiction not supported' });
        return;
      }

      const result = await provider.initiateCheck(investorId, info as KycApplicantInfo);
      res.status(201).json({ data: result });
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.statusCode).json(error.toResponse());
      } else {
        next(error);
      }
    }
  });

  return router;
}
