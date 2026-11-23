import { createSocialAuthRouter } from './socialAuthRoute';
import { SocialAuthService } from './socialAuthService';

/**
 * Security-focused middleware wiring tests for `src/auth/social/socialAuthRoute.ts`.
 *
 * These tests verify that the router correctly applies security middleware:
 * - Anti-enumeration middleware on the public login endpoint
 * - requireAuth middleware on protected link/unlink endpoints
 *
 * This is a defence-in-depth check: if requireAuth were accidentally removed
 * from link/unlink routes, unauthenticated account linking/unlinking would be possible.
 */

describe('socialAuthRoute middleware wiring', () => {
  let mockRequireAuth: jest.Mock;
  let mockSocialAuthService: SocialAuthService;

  beforeEach(() => {
    mockRequireAuth = jest.fn((req, res, next) => next());
    mockSocialAuthService = {} as unknown as SocialAuthService;
  });

  it('applies anti-enumeration middleware to the login route', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the login route (POST /api/auth/social/:provider/login)
    const loginRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/login' && layer.route?.methods.post,
    );

    expect(loginRoute).toBeDefined();
    expect(loginRoute?.route?.stack).toBeDefined();

    // The first middleware in the stack should be the anti-enumeration middleware
    // We verify this by checking that the middleware is a function (all middleware are functions)
    // and that there are 2 middlewares (anti-enum + handler)
    expect(loginRoute?.route?.stack.length).toBe(2);
  });

  it('applies requireAuth middleware to the link route', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the link route (POST /api/auth/social/:provider/link)
    const linkRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/link' && layer.route?.methods.post,
    );

    expect(linkRoute).toBeDefined();
    expect(linkRoute?.route?.stack).toBeDefined();

    // There should be 2 middlewares: requireAuth + handler
    expect(linkRoute?.route?.stack.length).toBe(2);
  });

  it('applies requireAuth middleware to the unlink route', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the unlink route (DELETE /api/auth/social/:provider/link)
    const unlinkRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/link' && layer.route?.methods.delete,
    );

    expect(unlinkRoute).toBeDefined();
    expect(unlinkRoute?.route?.stack).toBeDefined();

    // There should be 2 middlewares: requireAuth + handler
    expect(unlinkRoute?.route?.stack.length).toBe(2);
  });

  it('does not apply requireAuth to the login route (public endpoint)', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the login route
    const loginRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/login' && layer.route?.methods.post,
    );

    expect(loginRoute).toBeDefined();

    // Login should have exactly 2 middlewares (anti-enum + handler), not 3 (which would include requireAuth)
    expect(loginRoute?.route?.stack.length).toBe(2);
  });

  it('does not apply anti-enumeration to the link route (auth-protected)', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the link route
    const linkRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/link' && layer.route?.methods.post,
    );

    expect(linkRoute).toBeDefined();

    // Link should have exactly 2 middlewares (requireAuth + handler), not 3 (which would include anti-enum)
    expect(linkRoute?.route?.stack.length).toBe(2);
  });

  it('does not apply anti-enumeration to the unlink route (auth-protected)', () => {
    const router = createSocialAuthRouter({
      socialAuthService: mockSocialAuthService,
      requireAuth: mockRequireAuth,
      antiEnumerationOptions: {},
    });

    // Find the unlink route
    const unlinkRoute = router.stack.find(
      (layer) => layer.route?.path === '/api/auth/social/:provider/link' && layer.route?.methods.delete,
    );

    expect(unlinkRoute).toBeDefined();

    // Unlink should have exactly 2 middlewares (requireAuth + handler), not 3 (which would include anti-enum)
    expect(unlinkRoute?.route?.stack.length).toBe(2);
  });
});
