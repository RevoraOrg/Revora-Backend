import { NextFunction, Request, Response } from 'express';
import { OfferingService } from './offeringService';

export class OfferingHandler {
  constructor(private offeringService: OfferingService) {}

  /**
   * Handle GET /api/offerings/:id/stats
   */
  async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({ error: 'Offering ID is required' });
        return;
      }

      const stats = await this.offeringService.getOfferingStats(id);
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }
}
