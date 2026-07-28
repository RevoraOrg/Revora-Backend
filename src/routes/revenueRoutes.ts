import { Router, Request, Response, NextFunction } from 'express';
import { validateZodBody, validateZodParams } from '../middleware/validate';
import { z } from 'zod';
import { RevenueService, RevenueReportInput } from '../services/revenueService';
import { AppError } from '../lib/errors';
import { Logger } from '../lib/logger'; // Assuming a logger exists

/**
 * @title Revenue Routes
 * @notice Defines API endpoints for revenue report ingestion.
 * @dev These routes handle incoming revenue reports, apply schema validation,
 *      and delegate processing to the `RevenueService`.
 *
 * Security Assumptions:
 * - Input validation (format, type, range) is performed early using `validate` middleware.
 * - `POSITIVE_DECIMAL_REGEX` and `ISO_8601_DATE_REGEX` are robust against ReDoS.
 * - Error responses are structured and do not expose internal server details.
 * - Authentication middleware (not shown here, but assumed to be upstream) protects these endpoints.
 * - `RevenueService` handles all financial calculations and Soroban i128 conversions securely.
 */

// Regex for UUID v4 format
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Regex for positive decimal strings with up to 18 fractional digits.
// This is the same regex used in src/lib/decimal.ts for consistency.
const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d{1,18})?$/;

// Regex for ISO 8601 date or datetime strings.
const ISO_8601_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?)?$/;

const amountRefinement = (val: string) => {
  if (!POSITIVE_DECIMAL_REGEX.test(val)) return false;
  const num = Number(val);
  return !isNaN(num) && num > 0;
};

const baseFields = {
  amount: z.string().refine(amountRefinement, { message: "Invalid positive amount" }),
  periodStart: z.string().regex(ISO_8601_DATE_REGEX, { message: "Invalid date format" }),
  periodEnd: z.string().regex(ISO_8601_DATE_REGEX, { message: "Invalid date format" })
};

// Schema for offering ID parameter
const offeringIdParamsZodSchema = z.object({
  id: z.string().regex(UUID_V4_REGEX, "Invalid UUID")
});

// Schema for POST /offerings/:id/revenue
const offeringRevenueBodyZodSchema = z.object(baseFields).strict().refine((data) => {
  return new Date(data.periodEnd) > new Date(data.periodStart);
}, { message: "periodEnd must be after periodStart", path: ["periodEnd"] });

// Schema for POST /revenue-reports (includes offeringId in body)
const revenueReportBodyZodSchema = z.object({
  offeringId: z.string().regex(UUID_V4_REGEX, "Invalid UUID"),
  ...baseFields
}).strict().refine((data) => {
  return new Date(data.periodEnd) > new Date(data.periodStart);
}, { message: "periodEnd must be after periodStart", path: ["periodEnd"] });

export function createRevenueRoutes(revenueService: RevenueService, logger: Logger): Router {
  const router = Router();

  /**
   * POST /offerings/:id/revenue
   * Submits a revenue report for a specific offering.
   * Requires authentication and authorization (e.g., only issuer of the offering).
   */
  router.post(
    '/offerings/:id/revenue',
    validateZodParams(offeringIdParamsZodSchema),
    validateZodBody(offeringRevenueBodyZodSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { id: offeringId } = req.params;
        const { amount, periodStart, periodEnd } = req.body;

        const input: RevenueReportInput = {
          offeringId,
          amount,
          periodStart,
          periodEnd,
        };

        const transactionId = await revenueService.ingestRevenueReport(input);
        res.status(202).json({ message: 'Revenue report accepted for processing', transactionId });
      } catch (error) {
        logger.error('Error processing revenue report for offering', { error: error instanceof Error ? error.message : String(error), offeringId: req.params.id });
        next(error); // Pass to global error handler
      }
    }
  );

  /**
   * POST /revenue-reports
   * Submits a revenue report where the offering ID is part of the request body.
   * Requires authentication and authorization.
   */
  router.post(
    '/revenue-reports',
    validateZodBody(revenueReportBodyZodSchema),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { offeringId, amount, periodStart, periodEnd } = req.body;

        const input: RevenueReportInput = {
          offeringId,
          amount,
          periodStart,
          periodEnd,
        };

        const transactionId = await revenueService.ingestRevenueReport(input);
        res.status(202).json({ message: 'Revenue report accepted for processing', transactionId });
      } catch (error) {
        logger.error('Error processing revenue report', { error: error instanceof Error ? error.message : String(error), offeringId: req.body.offeringId });
        next(error); // Pass to global error handler
      }
    }
  );

  return router;
}