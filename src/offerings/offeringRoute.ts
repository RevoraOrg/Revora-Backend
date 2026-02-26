import { Router } from 'express';
import { OfferingHandler } from './offeringHandler';
import { OfferingService } from './offeringService';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { Pool } from 'pg';

export const createOfferingRouter = (db: Pool): Router => {
  const router = Router();
  
  const investmentRepo = new InvestmentRepository(db);
  const distributionRepo = new DistributionRepository(db);
  const offeringService = new OfferingService(investmentRepo, distributionRepo);
  const offeringHandler = new OfferingHandler(offeringService);

  // GET /api/offerings/:id/stats
  router.get('/:id/stats', (req, res, next) => offeringHandler.getStats(req, res, next));

  return router;
};
