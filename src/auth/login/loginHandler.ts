import { NextFunction, Request, RequestHandler, Response } from 'express';
import { LoginService } from './loginService';
import { LoginRequestBody } from './types';

/**
 * Express handler factory for `POST /api/auth/login`.
 *
 * Validates the request body, delegates to `LoginService`, and returns
 * either 200 with the JWT + user payload, or 401 for invalid credentials.
 */
export const createLoginHandler = (
    loginService: LoginService,
): RequestHandler => {
    return async (
        req: Request<unknown, unknown, LoginRequestBody>,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            const { email, password } = req.body ?? {};

            // ── Input validation ────────────────────────────────────────────
            if (!email || !password) {
                res.status(400).json({
                    error: 'Bad Request',
                    message: 'Both "email" and "password" are required.',
                });
                return;
            }

            if (typeof email !== 'string' || typeof password !== 'string') {
                res.status(400).json({
                    error: 'Bad Request',
                    message: '"email" and "password" must be strings.',
                });
                return;
            }

            // ── Attempt login ───────────────────────────────────────────────
            const result = await loginService.login(email, password);

            if (!result) {
                res.status(401).json({ error: 'Invalid email or password' });
                return;
            }

            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    };
};
