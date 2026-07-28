import { OfferingRepository } from '../db/repositories/offeringRepository';
import {
    RevenueReportRepository,
    CreateRevenueReportInput,
    RevenueReport,
} from '../db/repositories/revenueReportRepository';
import { Errors } from '../lib/errors';
import { Logger } from '../lib/logger';
import { LogLevel } from '../lib/logger';

export interface SubmitRevenueReportInput {
    offeringId: string;
    issuerId: string;
    amount: string;
    periodStart: Date;
    periodEnd: Date;
    requestId?: string;
}

/**
 * Decimal boundary limits for revenue amounts.
 * @dev Database schema uses NUMERIC(30,10) for amounts to preserve precision.
 *      This allows up to 20 integer digits and 10 decimal places (10^-10 cents minimum).
 */
const DECIMAL_LIMITS = {
    /** Maximum number of integer digits before decimal point */
    MAX_INTEGER_DIGITS: 20,
    /** Maximum number of fractional digits after decimal point */
    MAX_DECIMAL_PLACES: 10,
    /** Maximum representable amount (20 nines + decimal + 10 nines) */
    MAX_AMOUNT: '99999999999999999999.9999999999',
    /** Minimum positive amount (essentially 0.0000000001) */
    MIN_AMOUNT: '0.0000000001',
} as const;

/**
 * RevenueService: Business logic for revenue report submission and validation.
 *
 * Security Assumptions:
 * - The `issuerId` has been authenticated via JWT middleware before service invocation.
 * - The offering ownership check is performed before any state-modifying operations.
 * - Database transactions (if configured) provide ACID guarantees for concurrency safety.
 *
 * Validation Rules:
 * - Amount must be a positive decimal string with at most 10 decimal places (database NUMERIC precision).
 * - Period end must be strictly after period start (prevents zero-width or negative ranges).
 * - New reports cannot overlap with any existing report for the same offering.
 * - Amount cannot exceed 20 integer digits (prevents integer overflow in Stellar operations).
 *
 * @module services/revenueService
 */
export class RevenueService {
    private logger: Logger;

    constructor(
        private offeringRepo: OfferingRepository,
        private revenueReportRepo: RevenueReportRepository
    ) {
        this.logger = new Logger({ level: LogLevel.INFO });
    }

    /**
     * @notice Submits and validates a revenue report for a specific offering.
     * @dev Hardened with production-grade validation for amounts and reporting periods.
     * 
     * Decimal Precision:
     * - Database schema: NUMERIC(30,10) - supports up to 20 integer + 10 decimal places.
     * - Input validation: Rejects amounts exceeding these boundaries.
     * - String storage: Amounts stored as strings in JSON to preserve precision.
     * 
     * @param input - The revenue report data containing offering, amount, and period.
     * @returns The persisted RevenueReport object.
     * @throws AppError if validation fails or unauthorized access is detected.
     */
    async submitReport(input: SubmitRevenueReportInput): Promise<RevenueReport> {
        // 1. Validate offering existence and ownership
        const offering = await this.offeringRepo.findById(input.offeringId);
        if (!offering) {
            throw Errors.notFound(`Offering ${input.offeringId} not found`);
        }

        if (offering.issuer_id !== input.issuerId) {
            throw Errors.forbidden(`Unauthorized: Issuer does not own offering ${input.offeringId}`);
        }

        // 2. Validate amount format and value
        const amountStr = input.amount;
        const amountRegex = /^\d+(\.\d+)?$/;
        if (!amountRegex.test(amountStr)) {
            throw Errors.validationError('Invalid revenue amount format: must be a positive decimal string');
        }

        const [integerPart, fractionalPart = ''] = amountStr.split('.');

        if (integerPart.length > DECIMAL_LIMITS.MAX_INTEGER_DIGITS) {
            throw Errors.validationError(`Amount exceeds maximum integer digits of ${DECIMAL_LIMITS.MAX_INTEGER_DIGITS}`);
        }

        if (fractionalPart.length > DECIMAL_LIMITS.MAX_DECIMAL_PLACES) {
            throw Errors.validationError(`Decimal places exceed maximum ${DECIMAL_LIMITS.MAX_DECIMAL_PLACES} places`);
        }

        const numValue = parseFloat(amountStr);
        if (!Number.isFinite(numValue) || numValue <= 0) {
            throw Errors.validationError('Amount must be a positive number greater than zero');
        }

        const maxNum = parseFloat(DECIMAL_LIMITS.MAX_AMOUNT);
        if (numValue > maxNum) {
            throw Errors.validationError(`Amount exceeds maximum allowed value of ${DECIMAL_LIMITS.MAX_AMOUNT}`);
        }

        // 3. Validate period dates
        if (isNaN(input.periodStart.getTime()) || isNaN(input.periodEnd.getTime())) {
            throw Errors.validationError('Invalid date format for periodStart or periodEnd. Must be ISO 8601.');
        }

        if (input.periodEnd <= input.periodStart) {
            throw Errors.validationError('Invalid period: end date must be strictly after start date');
        }

        // 4. Enforce non-overlapping periods per offering
        const overlapping = await this.revenueReportRepo.findOverlappingReport(
            input.offeringId,
            input.periodStart,
            input.periodEnd
        );

        if (overlapping) {
            throw Errors.conflict(
                `A revenue report already exists that overlaps with the specified period (${input.periodStart.toISOString()} - ${input.periodEnd.toISOString()})`
            );
        }

        // 5. Save the report
        const reportData: CreateRevenueReportInput = {
            offering_id: input.offeringId,
            amount: input.amount,
            period_start: input.periodStart,
            period_end: input.periodEnd,
        };

        const report = await this.revenueReportRepo.create(reportData);

        this.emitDistributionEvent(report, input.requestId || '');

        return report;
    }

    private emitDistributionEvent(report: RevenueReport, requestId: string): void {
        this.logger.info(`Revenue report submitted for offering ${report.offering_id}. Triggering distribution engine...`, {
            requestId,
            reportId: report.id,
            offeringId: report.offering_id,
            amount: report.amount,
            periodStart: report.period_start,
            periodEnd: report.period_end,
        });
    }
}