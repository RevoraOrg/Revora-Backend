import { Router } from 'express';
import {
  createStartupRegisterRateLimit,
  StartupRegisterRateLimitOptions,
} from '../../middleware/startupRegisterRateLimit';
import { createRegisterHandler } from './registerHandler';
import { RegisterService } from './registerService';
import { IUserRepository } from './types';

export interface CreateRegisterRouterDeps {
  userRepository: IUserRepository;
  /**
   * Override rate-limit options — primarily used in tests to tighten or
   * disable the window without touching global state.
   */
  rateLimitOptions?: StartupRegisterRateLimitOptions;
}

/**
 * Creates an Express router that exposes:
 *
 *   POST /api/auth/investor/register   { email, password, name? }
 *
 * Returns 201 with `{ user: { id, email, role } }` on success.
 *
 * The route is protected by an in-process sliding-window rate limiter
 * (STARTUP_REGISTER window) to deter registration abuse.  The limiter
 * defaults to 5 attempts per IP per 15-minute window and can be
 * overridden via `rateLimitOptions` at the composition root.
 *
 * Wire up at the composition root (src/index.ts) by supplying a concrete
 * `userRepository` that satisfies `IUserRepository`.  The concrete
 * `UserRepository` class exposes `findUserByEmail`; an adapter is needed:
 *
 *   createRegisterRouter({
 *     userRepository: {
 *       findByEmail: (email) => userRepo.findUserByEmail(email),
 *       createUser:  (input) => userRepo.createUser(input),
 *     },
 *   })
 */
export const createRegisterRouter = ({
  userRepository,
  rateLimitOptions,
}: CreateRegisterRouterDeps): Router => {
  const router = Router();
  const registerService = new RegisterService(userRepository);
  const rateLimitMiddleware = createStartupRegisterRateLimit(rateLimitOptions);

  router.post(
    '/api/auth/investor/register',
    rateLimitMiddleware,
    createRegisterHandler(registerService),
  );

  return router;
};
