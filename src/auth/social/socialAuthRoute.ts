import { Router, RequestHandler } from 'express';
import {
  createSocialLinkHandler,
  createSocialLoginHandler,
  createSocialUnlinkHandler,
} from './socialAuthHandler';
import { SocialAuthService } from './socialAuthService';
import {
  createSocialAntiEnumerationMiddleware,
  SocialAntiEnumerationOptions,
} from '../../middleware/socialAntiEnumerationMiddleware';

export interface SocialAuthRouterDependencies {
  socialAuthService: SocialAuthService;
  requireAuth: RequestHandler;
  /** Optional override for the anti-enumeration rate-limiter policy. */
  antiEnumerationOptions?: SocialAntiEnumerationOptions;
}

/**
 * @notice Mounts the social-auth routes with the anti-enumeration middleware
 *         applied to the public login endpoint.
 *
 * @dev    Route structure:
 *         - POST   /api/auth/social/:provider/login   — rate-limited per provider+sub
 *         - POST   /api/auth/social/:provider/link    — auth-required
 *         - DELETE /api/auth/social/:provider/link    — auth-required
 */
export function createSocialAuthRouter(deps: SocialAuthRouterDependencies): Router {
  const router = Router();

  const antiEnumeration = createSocialAntiEnumerationMiddleware(
    deps.antiEnumerationOptions ?? {},
  );

  router.post(
    '/api/auth/social/:provider/login',
    antiEnumeration,
    createSocialLoginHandler(deps.socialAuthService),
  );
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
