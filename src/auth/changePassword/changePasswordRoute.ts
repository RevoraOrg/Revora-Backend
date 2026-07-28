import { Router, RequestHandler } from 'express';
import { Pool } from 'pg';
import { UserRepository } from '../../db/repositories/userRepository';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { ChangePasswordService, ChangePasswordUserRepo } from './changePasswordService';
import { createChangePasswordHandler } from './changePasswordHandler';
import { Logger } from '../../lib/logger';

// ── Adapter ──────────────────────────────────────────��────────────────────────
// Bridges the port interface to the concrete UserRepository without modifying it.
class UserRepoAdapter implements ChangePasswordUserRepo {
  constructor(private readonly repo: UserRepository) {}

  findUserById(id: string) {
    return this.repo.findById(id);
  }

  async updatePasswordHash(userId: string, newHash: string): Promise<void> {
    // updatePasswordHash() in the existing repo accepts (userId, newHash)
    await this.repo.updatePasswordHash(userId, newHash);
  }
}

// ── Router factory ────────────────────────────────────────────────────────────
export function createChangePasswordRouter(opts: {
  db: Pool;
  requireAuth: RequestHandler;
}): Router {
  const router = Router();

  const userRepo = new UserRepository(opts.db);
  const sessionRepo = new SessionRepository(opts.db);
  const logger = new Logger({ serviceName: 'change-password' });
  const repoAdapter = new UserRepoAdapter(userRepo);
  const service = new ChangePasswordService(repoAdapter, sessionRepo, opts.db, logger);
  const handler = createChangePasswordHandler(service) as RequestHandler;

  /**
   * POST /api/v1/users/me/change-password
   * PATCH /api/v1/users/me/password         (alias)
   *
   * Body: { currentPassword: string, newPassword: string }
   * Auth: Bearer JWT (or x-user-id stub in dev)
   */
  router.post('/me/change-password', opts.requireAuth, handler);
  router.patch('/me/password', opts.requireAuth, handler);

  return router;
}