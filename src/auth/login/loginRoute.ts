import { Router } from 'express';
import { LoginService } from './loginService';
import { createLoginHandler } from './loginHandler';

export interface LoginRouterDependencies {
  loginService: LoginService;
}

/**
 * Express router factory for `POST /api/auth/login`.
 */
export function createLoginRouter(deps: LoginRouterDependencies): Router {
  const router = Router();
  const handler = createLoginHandler(deps.loginService);

  router.post('/api/auth/login', handler);

  return router;
}
