import { Response } from 'express';
import { RevenueService } from '../services/revenueService';
import { AuthenticatedRequest } from '../middleware/auth';

export class RevenueHandler {
    constructor(private revenueService: RevenueService) { }

    /**
     * Handle POST /api/offerings/:id/revenue
     */
    submitReport = async (req: AuthenticatedRequest, res: Response) => {
        try {
            const offeringId = req.params.id;
            const issuerId = req.user?.id;

            if (!issuerId) {
                return res.status(401).json({ error: 'Unauthorized: User not authenticated' });
            }

            const { amount, periodStart, periodEnd } = req.body;

            if (!amount || !periodStart || !periodEnd) {
                return res.status(400).json({
                    error: 'Missing required fields: amount, periodStart, periodEnd',
                });
            }

            const report = await this.revenueService.submitReport({
                offeringId,
                issuerId,
                amount,
                periodStart: new Date(periodStart),
                periodEnd: new Date(periodEnd),
            });

            return res.status(201).json({
                message: 'Revenue report submitted successfully',
                data: report,
            });
        } catch (error: any) {
            const statusCode = error.message.includes('Unauthorized') ? 403 : 400;
            return res.status(statusCode).json({ error: error.message });
        }
    };
}
