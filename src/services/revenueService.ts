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
     * Submit a revenue report for an offering
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

        // 2. Validate amount
        const amountNum = parseFloat(input.amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            throw new Error('Invalid revenue amount: must be a positive number');
        }

        // 3. Validate period
        if (input.periodEnd <= input.periodStart) {
            throw new Error('Invalid period: end date must be after start date');
        }

        // 4. Enforce idempotency per offering + period
        const existing = await this.revenueReportRepo.findByOfferingAndPeriod(
            input.offeringId,
            input.periodStart,
            input.periodEnd
        );

        if (existing) {
            throw new Error(
                `Revenue report already exists for offering ${input.offeringId} and specified period`
            );
        }

        // 5. Persist report
        const report = await this.revenueReportRepo.create({
            offering_id: input.offeringId,
            issuer_id: input.issuerId,
            amount: input.amount,
            period_start: input.periodStart,
            period_end: input.periodEnd,
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
