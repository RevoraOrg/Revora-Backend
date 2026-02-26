import { Router, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth';
import { UserRepository } from '../db/repositories/userRepository';

export interface UserRepo {
  findUserById(id: string): Promise<{ id: string; email: string; role: string; created_at: Date } | null>;
}

/**
 * Creates the /me handler with an injected UserRepo.
 * Exported so tests can inject a mock repo without needing supertest or a real DB.
 */
export function createUserHandler(userRepo: UserRepo) {
  return async function getMeHandler(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: No user found' });
      }

      const user = await userRepo.findUserById(userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Return only the required fields; password_hash is never included
      return res.status(200).json({
        id: user.id,
        email: user.email,
        name: (user as any).name ?? null,
        role: user.role,
        created_at: user.created_at,
      });
    } catch (error) {
      console.error('Error in /users/me:', error);
      return next(error);
    }
  };
}

/**
 * @route   GET /api/users/me
 * @desc    Get the profile of the currently authenticated user
 * @access  Private (requires JWT via authMiddleware)
 *
 * The Pool is created lazily here so this file remains self-contained
 * and importable without a shared db/pool module.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const router = Router();
const userRepository = new UserRepository(pool);

router.get('/me', authMiddleware, createUserHandler(userRepository));

export default router;