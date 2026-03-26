import { Router } from 'express';
import { RefreshService } from './refreshService';
import { createRefreshHandler } from './refreshHandler';

export interface RefreshRouterDependencies {
  refreshService: RefreshService;
}

/**
 * Express router factory for `POST /api/auth/refresh`.
 */
export function createRefreshRouter(deps: RefreshRouterDependencies): Router {
  const router = Router();
  const handler = createRefreshHandler(deps.refreshService);

  router.post('/api/auth/refresh', handler);

  return router;
}
