import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { UserRepository } from '../db/repositories/userRepository';
import { StartupAuthService } from '../services/startupAuthService';

/**
 * Startup Registration Route
 * @param db Database pool
 * @returns Express router
 */
export function createStartupAuthRouter(db: Pool): Router {
    const router = Router();
    const userRepository = new UserRepository(db);
    const authService = new StartupAuthService(userRepository);

    router.post('/register', async (req: Request, res: Response) => {
        const { email, password, name } = req.body;

        // Basic validation
        if (!email || !password) {
            return res.status(400).json({
                error: 'Email and password are required',
            });
        }

        // Email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'Invalid email format',
            });
        }

        // Password length validation
        if (password.length < 8) {
            return res.status(400).json({
                error: 'Password must be at least 8 characters long',
            });
        }

        try {
            const result = await authService.register({
                email,
                password,
                name,
            });

            if (!result.success) {
                return res.status(result.statusCode).json({
                    error: result.error,
                });
            }

            return res.status(201).json({
                message: 'Startup user registered successfully',
                user: result.user,
            });
        } catch (error) {
            console.error('Registration handler error:', error);
            return res.status(500).json({
                error: 'Internal server error',
            });
        }
    });

    return router;
}
