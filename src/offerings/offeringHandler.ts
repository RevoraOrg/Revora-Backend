import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { Errors } from '../lib/errors';
import { OfferingService } from './offeringService';

const catalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  offset: z.coerce.number().int().min(0).optional().default(0),
  statuses: z
    .union([
      z.string().transform((value: string) =>
        value
          .split(',')
          .map((entry: string) => entry.trim())
          .filter(Boolean),
      ),
      z.array(z.string()),
    ])
    .optional()
    .default(['active', 'completed']),
});

export class OfferingHandler {
  constructor(private readonly offeringService: OfferingService) {}

  async getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        next(Errors.badRequest('Offering ID is required'));
        return;
      }

      const stats = await this.offeringService.getOfferingStats(id);
      res.json(stats);
    } catch (error) {
      next(error);
    }
  }

  async getCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = catalogQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        next(
          Errors.validationError(
            'Invalid query parameters',
            parsed.error.flatten(),
          ),
        );
        return;
      }

      const { limit, offset, statuses } = parsed.data;
      const catalog = await this.offeringService.getCatalog(limit, offset, statuses);

      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        data: catalog,
        pagination: { limit, offset, count: catalog.length },
      });
    } catch (error) {
      next(error);
    }
  }
}
