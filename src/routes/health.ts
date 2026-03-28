import { NextFunction, Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AppError, Errors } from '../lib/errors';

export type HealthDependency = 'database' | 'stellar-horizon';

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Maps dependency failures into a stable, reviewable API error shape.
 * Raw upstream error messages are intentionally not exposed to clients.
 */
export function mapHealthDependencyFailure(
  dependency: HealthDependency,
  cause: unknown,
): AppError {
  const details: Record<string, unknown> = { dependency };

  if (dependency === 'stellar-horizon' && typeof cause === 'object' && cause !== null) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === 'number') {
      details.upstreamStatus = status;
    }
  }

  return Errors.serviceUnavailable('Dependency unavailable', details);
}

export const healthReadyHandler =
  (db: QueryableDb) =>
  async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await db.query('SELECT 1');
    } catch (dbError) {
      next(mapHealthDependencyFailure('database', dbError));
      return;
    }

    try {
      const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
      const response = await fetch(horizonUrl);

      if (!response.ok) {
        next(mapHealthDependencyFailure('stellar-horizon', { status: response.status }));
        return;
      }
    } catch (stellarError) {
      next(mapHealthDependencyFailure('stellar-horizon', stellarError));
      return;
    }

    res.status(200).json({
      status: 'ok',
      db: 'up',
      stellar: 'up',
    });
  };

export const createHealthRouter = (db: QueryableDb): Router => {
  const router = Router();
  router.get('/ready', healthReadyHandler(db));
  return router;
};

export default createHealthRouter;