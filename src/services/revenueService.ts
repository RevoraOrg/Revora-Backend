import { OfferingRepository } from '../db/repositories/offeringRepository';
import {
    RevenueReportRepository,
    CreateRevenueReportInput,
    RevenueReport,
} from '../db/repositories/revenueReportRepository';

export interface SubmitRevenueReportInput {
    offeringId: string;
    issuerId: string;
    amount: string;
    periodStart: Date;
    periodEnd: Date;
}

export class RevenueService {
    constructor(
        private offeringRepo: OfferingRepository,
        private revenueReportRepo: RevenueReportRepository
    ) { }

    /**
     * @notice Submits and validates a revenue report for a specific offering.
     * @dev Hardened with production-grade validation for amounts and reporting periods.
     * 
     * Security Assumptions:
     * 1. The `issuerId` has been authenticated via JWT middleware.
     * 2. The `issuerId` is the primary owner of the `offeringId`.
     * 
     * Validation Rules:
     * - Amount must be a valid positive decimal string (max 10 decimal places).
     * - Period end date must be strictly after the start date.
     * - New reports cannot overlap with any existing reports for the same offering.
     * 
     * @param input - The revenue report data containing offering, amount, and period.
     * @returns The persisted RevenueReport object.
     * @throws Error if validation fails or unauthorized access is detected.
     */
    async submitReport(input: SubmitRevenueReportInput): Promise<RevenueReport> {
        // 1. Validate offering existence and ownership
        const offering = await this.offeringRepo.findById(input.offeringId);
        if (!offering) {
            throw new Error(`Offering ${input.offeringId} not found`);
        }

        if (offering.issuer_id !== input.issuerId) {
            throw new Error(`Unauthorized: Issuer does not own offering ${input.offeringId}`);
        }

        // 2. Validate amount format and value
        const amountRegex = /^\d+(\.\d{1,10})?$/;
        if (!amountRegex.test(input.amount)) {
            throw new Error('Invalid revenue amount format: must be a positive decimal string (max 10 decimal places)');
        }

        const amountNum = parseFloat(input.amount);
        if (amountNum <= 0) {
            throw new Error('Invalid revenue amount: must be greater than zero');
        }

        // 3. Validate period logic
        if (input.periodEnd <= input.periodStart) {
            throw new Error('Invalid period: end date must be strictly after start date');
        }

        // 4. Enforce non-overlapping periods per offering
        const overlapping = await this.revenueReportRepo.findOverlappingReport(
            input.offeringId,
            input.periodStart,
            input.periodEnd
        );

        if (overlapping) {
            throw new Error(
                `A revenue report already exists that overlaps with the specified period (${input.periodStart.toISOString()} - ${input.periodEnd.toISOString()})`
            );
        }

        // 5. Persist report
        const report = await this.revenueReportRepo.create({
            offering_id: input.offeringId,
            issuer_id: input.issuerId,
            amount: input.amount,
            period_start: input.periodStart,
            period_end: input.periodEnd,
            reported_by: input.issuerId, // Assuming reporter is the issuer for now
        });

        // 6. Optionally emit event for distribution engine
        this.emitDistributionEvent(report);

        return report;
    }

    private emitDistributionEvent(report: RevenueReport) {
        // Placeholder for event emission logic
        // This could be a message to a queue (e.g., RabbitMQ, Kafka) or a PubSub system
        // eslint-disable-next-line no-console
        console.log(
            `[Event] Revenue report submitted: ${report.id} for offering ${report.offering_id}. Triggering distribution engine...`
        );
    }
}
