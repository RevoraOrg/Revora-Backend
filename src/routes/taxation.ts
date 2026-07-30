/**
 * Taxation Routes
 *
 * Route registration for tax cost-basis operations.
 * All routes require authentication via requireAuth middleware.
 *
 * Endpoints:
 * - POST /taxation/dispose — Process a disposal with specified cost-basis strategy
 * - POST /taxation/preview — Preview a disposal without executing
 * - GET /taxation/gains-summary — Get per-jurisdiction gains totals
 * - GET /taxation/lots — List investment lots for authenticated investor
 * - POST /taxation/lots — Create a new investment lot
 *
 * @module routes/taxation
 */

import { Router } from 'express';
import { TaxationHandler } from '../handlers/taxationHandler';
import { createTaxationService } from '../services/taxation/taxationService';
import { pool } from '../db/pool';
import { authMiddleware } from '../middleware/auth';

const router = Router();
const taxationService = createTaxationService(pool);
const taxationHandler = new TaxationHandler(taxationService);

// All taxation routes require JWT authentication
router.use(authMiddleware());

// Process a disposal (sell/transfer investment units)
router.post('/dispose', taxationHandler.processDisposal);

// Preview a disposal without committing
router.post('/preview', taxationHandler.previewDisposal);

// Detect wash-sale conditions and record adjustments
router.post('/wash-sale-detection', taxationHandler.detectWashSales);

// Get per-jurisdiction gains summary
router.get('/gains-summary', taxationHandler.getGainsSummary);

// List investment lots
router.get('/lots', taxationHandler.listLots);

// Create a new investment lot
router.post('/lots', taxationHandler.createLot);

export default router;
