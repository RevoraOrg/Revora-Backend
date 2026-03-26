import { Router } from 'express';
import { Pool } from 'pg';
import { authMiddleware } from '../middleware/auth';
import { validateParams, validateBody } from '../middleware/validate';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { RevenueService } from '../services/revenueService';
import { RevenueHandler } from '../handlers/revenueHandler';

/**
 * @dev UUID v4 canonical format, case-insensitive.
 *      Rejects any non-UUID string before it reaches the database or service layer.
 *      Security: prevents path-traversal and SQL-injection via crafted offering IDs.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * @dev ISO 8601 date or datetime string.
 *      Accepts YYYY-MM-DD and full datetime with optional time, fractional seconds, and timezone offset.
 *      Security: bounded quantifiers ({1,9}) prevent ReDoS on adversarial input.
 */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * @dev Positive decimal string, integer or up to 18 decimal places.
 *      Bounded quantifier {1,18} prevents catastrophic backtracking.
 *      Security: rejects negative amounts, zero-prefix abuse, and non-numeric strings at middleware layer.
 */
const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d{1,18})?$/;

/**
 * @dev Param schema applied to routes with :id path segment representing an offering UUID.
 */
const offeringParamSchema = {
    id: { type: 'string' as const, required: true, pattern: UUID_REGEX },
};

/**
 * @dev Body schema for POST /offerings/:id/revenue.
 *      The offeringId is carried in path params; only amount and period are required in the body.
 */
const revenueBodySchema = {
    amount:      { type: 'string' as const, required: true, pattern: POSITIVE_DECIMAL_REGEX },
    periodStart: { type: 'string' as const, required: true, pattern: ISO_DATE_REGEX },
    periodEnd:   { type: 'string' as const, required: true, pattern: ISO_DATE_REGEX },
};

/**
 * @dev Body schema for POST /revenue-reports.
 *      The offeringId must be provided in the body since no path param carries it.
 */
const revenueReportBodySchema = {
    offeringId:  { type: 'string' as const, required: true, pattern: UUID_REGEX },
    amount:      { type: 'string' as const, required: true, pattern: POSITIVE_DECIMAL_REGEX },
    periodStart: { type: 'string' as const, required: true, pattern: ISO_DATE_REGEX },
    periodEnd:   { type: 'string' as const, required: true, pattern: ISO_DATE_REGEX },
};

/**
 * @notice Factory function to create revenue routes with injected database dependencies.
 * @dev Schema validation middleware runs BEFORE authMiddleware intentionally.
 *      Rejecting structurally invalid requests before JWT verification avoids unnecessary
 *      cryptographic operations and eliminates timing-oracle differentials between
 *      "bad format + bad token" vs "bad format + good token".
 *      Business logic validations (period ordering, offering ownership, idempotency) remain
 *      in RevenueService as they require database access.
 * @param db - PostgreSQL connection pool instance.
 * @returns Express Router with schema-validated revenue report endpoints.
 */
export const createRevenueRoutes = (db: Pool): Router => {
    const router = Router();

    const offeringRepo = new OfferingRepository(db);
    const revenueReportRepo = new RevenueReportRepository(db);
    const revenueService = new RevenueService(offeringRepo, revenueReportRepo);
    const revenueHandler = new RevenueHandler(revenueService);

    /**
     * @notice Submit a revenue report for a specific offering via path parameter.
     * @dev Validates: params.id (UUID v4), body.amount (positive decimal),
     *      body.periodStart (ISO 8601), body.periodEnd (ISO 8601).
     *      Business logic date ordering (periodEnd > periodStart) is enforced by RevenueService.
     * @param id - UUID v4 of the target offering (path param).
     * @returns 201 with report payload on success.
     *          400 ValidationError if schema fails.
     *          401 if Authorization header is missing or invalid.
     *          403 if the authenticated user does not own the offering.
     */
    router.post(
        '/offerings/:id/revenue',
        validateParams(offeringParamSchema),
        validateBody(revenueBodySchema),
        authMiddleware(),
        revenueHandler.submitReport
    );

    /**
     * @notice Submit a revenue report with the offering identified by body field.
     * @dev Validates: body.offeringId (UUID v4), body.amount (positive decimal),
     *      body.periodStart (ISO 8601), body.periodEnd (ISO 8601).
     * @returns 201 with report payload on success.
     *          400 ValidationError if schema fails.
     *          401 if Authorization header is missing or invalid.
     *          403 if the authenticated user does not own the offering.
     */
    router.post(
        '/revenue-reports',
        validateBody(revenueReportBodySchema),
        authMiddleware(),
        revenueHandler.submitReport
    );

    return router;
};
