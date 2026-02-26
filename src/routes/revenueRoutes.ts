import { Router } from 'express';
import { Pool } from 'pg';
import { authMiddleware } from '../middleware/auth';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { RevenueService } from '../services/revenueService';
import { RevenueHandler } from '../handlers/revenueHandler';

/**
 * Factory function to create revenue routes with injected dependencies
 */
export const createRevenueRoutes = (db: Pool): Router => {
    const router = Router();

    // Initialize dependencies
    const offeringRepo = new OfferingRepository(db);
    const revenueReportRepo = new RevenueReportRepository(db);
    const revenueService = new RevenueService(offeringRepo, revenueReportRepo);
    const revenueHandler = new RevenueHandler(revenueService);

    /**
     * @route POST /api/offerings/:id/revenue
     * @desc Submit a revenue report for an offering
     * @access Private (Issuer)
     */
    router.post(
        '/offerings/:id/revenue',
        authMiddleware as any,
        revenueHandler.submitReport
    );

    /**
     * Alternative route as per description: POST /api/revenue-reports
     */
    router.post(
        '/revenue-reports',
        authMiddleware as any,
        revenueHandler.submitReport
    );

    return router;
};
