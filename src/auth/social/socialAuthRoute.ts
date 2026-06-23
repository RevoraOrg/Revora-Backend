import { Router, RequestHandler } from 'express';
import {
  createSocialLinkHandler,
  createSocialLoginHandler,
  createSocialUnlinkHandler,
} from './socialAuthHandler';
import { SocialAuthService } from './socialAuthService';

export interface SocialAuthRouterDependencies {
  socialAuthService: SocialAuthService;
  requireAuth: RequestHandler;
}

export function createSocialAuthRouter(deps: SocialAuthRouterDependencies): Router {
  const router = Router();

  router.post('/api/auth/social/:provider/login', createSocialLoginHandler(deps.socialAuthService));
  router.post(
    '/api/auth/social/:provider/link',
    deps.requireAuth,
    createSocialLinkHandler(deps.socialAuthService),
  );
  router.delete(
    '/api/auth/social/:provider/link',
    deps.requireAuth,
    createSocialUnlinkHandler(deps.socialAuthService),
  );

  return router;
}
