import { Router, Request, Response } from 'express';
import { OfferingSyncService, RealStellarClient, StaleCatalogConfig } from '../services/offeringSyncService';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { pool } from '../db/pool';
import { Logger, globalLogger } from '../lib/logger';
import { Errors, ErrorCode } from '../lib/errors';
import { createRequireAuth } from '../middleware/auth';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { z } from 'zod';

/**
 * Request/Response schemas for validation
 */
const syncOfferingSchema = z.object({
  offeringId: z.string().min(1, 'Offering ID is required'),
});

const recoverStaleCatalogSchema = z.object({
  staleThresholdHours: z.number().min(1).max(168).optional(), // Max 1 week
  batchSize: z.number().min(1).max(100).optional(), // Max 100 items
  autoUpdate: z.boolean().optional(),
});

/**
 * Dependencies for route handlers
 */
interface SyncDependencies {
  offeringSyncService: OfferingSyncService;
  logger: Logger;
}

/**
 * Create offering sync dependencies
 */
function createDependencies(): SyncDependencies {
  const offeringRepository = new OfferingRepository(pool);
  const stellarClient = new RealStellarClient({ logger: globalLogger.child({ component: 'StellarClient' }) });
  const offeringSyncService = new OfferingSyncService(
    offeringRepository,
    stellarClient,
    { logger: globalLogger.child({ component: 'OfferingSyncService' }) }
  );

  return {
    offeringSyncService,
    logger: globalLogger.child({ component: 'OfferingSyncRoutes' }),
  };
}

/**
 * Sync a single offering
 */
async function syncOfferingHandler(req: Request, res: Response, deps: SyncDependencies) {
  try {
    const { offeringId } = syncOfferingSchema.parse(req.body);
    const { requestId } = req as Request & { requestId?: string };

    deps.logger.info('Sync offering request', { offeringId, requestId });

    const result = await deps.offeringSyncService.syncOffering(offeringId);

    if (!result.success) {
      if (result.error?.includes('not found')) {
        const error = Errors.notFound('Offering not found');
        return res.status(error.statusCode).json(error.toResponse(requestId));
      }

      if (result.failureClass) {
        const statusCode = getStatusCodeForFailureClass(result.failureClass);
        const error = Errors.serviceUnavailable('Stellar service temporarily unavailable', {
          failureClass: result.failureClass,
          offeringId,
        });
        return res.status(statusCode).json(error.toResponse(requestId));
      }

      const error = Errors.internal('Failed to sync offering', { offeringId });
      return res.status(error.statusCode).json(error.toResponse(requestId));
    }

    deps.logger.info('Offering sync completed', {
      offeringId,
      success: result.success,
      updated: result.updated,
      duration: result.duration,
    });

    res.json({
      success: true,
      data: {
        offeringId: result.offeringId,
        contractAddress: result.contractAddress,
        updated: result.updated,
        duration: result.duration,
      },
    });
  } catch (error) {
    deps.logger.error('Sync offering handler error', {
      error: error instanceof Error ? error.message : String(error),
      body: req.body,
    });

    if (error instanceof z.ZodError) {
      const validationError = Errors.validationError('Invalid request parameters', error.errors);
      return res.status(validationError.statusCode).json(validationError.toResponse((req as any).requestId));
    }

    const internalError = Errors.internal('Internal server error');
    res.status(internalError.statusCode).json(internalError.toResponse((req as any).requestId));
  }
}

/**
 * Sync all offerings
 */
async function syncAllHandler(req: Request, res: Response, deps: SyncDependencies) {
  try {
    const { requestId } = req as Request & { requestId?: string };

    deps.logger.info('Sync all offerings request', { requestId });

    const results = await deps.offeringSyncService.syncAll();

    const summary = {
      total: results.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      updated: results.filter(r => r.updated).length,
    };

    deps.logger.info('Sync all offerings completed', {
      ...summary,
      requestId,
    });

    res.json({
      success: true,
      data: {
        summary,
        results: results.map(r => ({
          offeringId: r.offeringId,
          contractAddress: r.contractAddress,
          success: r.success,
          updated: r.updated,
          error: r.error,
          duration: r.duration,
        })),
      },
    });
  } catch (error) {
    deps.logger.error('Sync all handler error', {
      error: error instanceof Error ? error.message : String(error),
    });

    const internalError = Errors.internal('Failed to sync all offerings');
    res.status(internalError.statusCode).json(internalError.toResponse((req as any).requestId));
  }
}

/**
 * Recover stale catalog entries
 */
async function recoverStaleCatalogHandler(req: Request, res: Response, deps: SyncDependencies) {
  try {
    const config = recoverStaleCatalogSchema.parse(req.body);
    const { requestId } = req as Request & { requestId?: string };

    deps.logger.info('Recover stale catalog request', { config, requestId });

    const result = await deps.offeringSyncService.recoverStaleCatalog(config);

    deps.logger.info('Stale catalog recovery completed', {
      totalProcessed: result.totalProcessed,
      updated: result.updated,
      failed: result.failed,
      duration: result.duration,
      requestId,
    });

    res.json({
      success: true,
      data: {
        totalProcessed: result.totalProcessed,
        staleFound: result.staleFound,
        updated: result.updated,
        failed: result.failed,
        errors: result.errors,
        duration: result.duration,
      },
    });
  } catch (error) {
    deps.logger.error('Recover stale catalog handler error', {
      error: error instanceof Error ? error.message : String(error),
      body: req.body,
    });

    if (error instanceof z.ZodError) {
      const validationError = Errors.validationError('Invalid request parameters', error.errors);
      return res.status(validationError.statusCode).json(validationError.toResponse((req as any).requestId));
    }

    const internalError = Errors.internal('Failed to recover stale catalog');
    res.status(internalError.statusCode).json(internalError.toResponse((req as any).requestId));
  }
}

/**
 * Get sync statistics
 */
async function getSyncStatsHandler(req: Request, res: Response, deps: SyncDependencies) {
  try {
    const { requestId } = req as Request & { requestId?: string };

    deps.logger.debug('Get sync stats request', { requestId });

    const stats = await deps.offeringSyncService.getSyncStats();

    res.json({
      success: true,
      data: {
        ...stats,
        staleThreshold: stats.staleThreshold.toISOString(),
      },
    });
  } catch (error) {
    deps.logger.error('Get sync stats handler error', {
      error: error instanceof Error ? error.message : String(error),
    });

    const internalError = Errors.internal('Failed to get sync statistics');
    res.status(internalError.statusCode).json(internalError.toResponse((req as any).requestId));
  }
}

/**
 * Map Stellar RPC failure class to HTTP status code
 */
function getStatusCodeForFailureClass(failureClass: string): number {
  switch (failureClass) {
    case 'TIMEOUT':
      return 504; // Gateway Timeout
    case 'RATE_LIMIT':
      return 429; // Too Many Requests
    case 'UNAUTHORIZED':
      return 401; // Unauthorized
    case 'UPSTREAM_ERROR':
      return 502; // Bad Gateway
    case 'MALFORMED_RESPONSE':
      return 502; // Bad Gateway
    default:
      return 503; // Service Unavailable
  }
}

/**
 * Create offering sync router
 */
export function createOfferingSyncRouter(): Router {
  const router = Router();
  const deps = createDependencies();
  const sessionRepository = new SessionRepository(pool);
  const requireAuth = createRequireAuth(sessionRepository);

  // POST /api/v1/offerings/sync - Sync a single offering
  router.post('/sync', requireAuth, async (req, res) => {
    await syncOfferingHandler(req, res, deps);
  });

  // POST /api/v1/offerings/sync/all - Sync all offerings
  router.post('/sync/all', requireAuth, async (req, res) => {
    await syncAllHandler(req, res, deps);
  });

  // POST /api/v1/offerings/sync/recover-stale - Recover stale catalog
  router.post('/sync/recover-stale', requireAuth, async (req, res) => {
    await recoverStaleCatalogHandler(req, res, deps);
  });

  // GET /api/v1/offerings/sync/stats - Get sync statistics
  router.get('/sync/stats', requireAuth, async (req, res) => {
    await getSyncStatsHandler(req, res, deps);
  });

  return router;
}
