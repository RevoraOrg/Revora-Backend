import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { OfferingService } from './offeringService';

const catalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  offset: z.coerce.number().int().min(0).optional().default(0),
  statuses: z.union([
    z.string().transform((s: string) => s.split(',').map((v: string) => v.trim())),
    z.array(z.string())
  ]).optional().default(['active', 'completed'])
});

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

  /**
   * Handle GET /api/offerings/catalog
   */
  async getCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = catalogQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.format() });
        return;
      }

      const { limit, offset, statuses } = parsed.data;
      const catalog = await this.offeringService.getCatalog(limit, offset, statuses);
      
      // Set short caching headers
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        data: catalog,
        pagination: { limit, offset, count: catalog.length }
      });
    } catch (error) {
      next(error);
    }
  }
}
