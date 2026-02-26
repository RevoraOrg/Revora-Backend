import { Router } from 'express';
import { createRegisterHandler } from './registerHandler';
import { RegisterService } from './registerService';
import { IUserRepository } from './types';

export interface CreateRegisterRouterDeps {
  userRepository: IUserRepository;
}

/**
 * Creates an Express router that exposes:
 *
 *   POST /api/auth/investor/register   { email, password, name? }
 *
 * Returns 201 with `{ user: { id, email, role } }` on success.
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
}: CreateRegisterRouterDeps): Router => {
  const router = Router();
  const registerService = new RegisterService(userRepository);

  router.post('/api/auth/investor/register', createRegisterHandler(registerService));

  return router;
};
