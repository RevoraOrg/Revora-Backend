import { NextFunction, Request, Response, Router } from 'express';
import { OfferingHandler } from './offeringHandler';
import { OfferingService } from './offeringService';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { DistributionRepository } from '../db/repositories/distributionRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { Pool } from 'pg';

export const createOfferingRouter = (db: Pool): Router => {
  const router = Router();
  
  const investmentRepo = new InvestmentRepository(db);
  const distributionRepo = new DistributionRepository(db);
  const offeringRepo = new OfferingRepository(db);
  const offeringService = new OfferingService(investmentRepo, distributionRepo, offeringRepo);
  const offeringHandler = new OfferingHandler(offeringService);

  // GET /api/offerings/catalog
  router.get('/catalog', (req: Request, res: Response, next: NextFunction) => offeringHandler.getCatalog(req, res, next));

  // GET /api/offerings/:id/stats
  router.get('/:id/stats', (req: Request, res: Response, next: NextFunction) => offeringHandler.getStats(req, res, next));

  return router;
};
