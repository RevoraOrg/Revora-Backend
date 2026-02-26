import { Router } from 'express';
import { createLoginHandler } from './loginHandler';
import { LoginService } from './loginService';
import { JwtIssuer, SessionRepository, UserRepository } from './types';

/**
 * Dependencies required to wire the login route.
 *
 * These are satisfied by concrete implementations at composition-root
 * level (e.g. inside `src/index.ts`), keeping this module decoupled
 * from database drivers, JWT libraries, etc.
 */
export interface CreateLoginRouterDeps {
    userRepository: UserRepository;
    sessionRepository: SessionRepository;
    jwtIssuer: JwtIssuer;
}

/**
 * Create an Express router that exposes:
 *
 *   POST /api/auth/login   { email, password }
 *
 * Returns 200 with `{ token, user: { id, email, role } }` on success,
 * or 401 for invalid credentials.
 */
export const createLoginRouter = ({
    userRepository,
    sessionRepository,
    jwtIssuer,
}: CreateLoginRouterDeps): Router => {
    const router = Router();
    const loginService = new LoginService(
        userRepository,
        sessionRepository,
        jwtIssuer,
    );

    router.post('/api/auth/login', createLoginHandler(loginService));

    return router;
};
