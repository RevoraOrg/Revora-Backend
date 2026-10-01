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
   * POST /me/change-password
   * PATCH /me/password          (alias)
   *
   * Mounted at the application root in src/app.ts (no path prefix), so the
   * effective public paths are exactly the two listed above.
   *
   * Auth: Bearer JWT via createRequireAuth (session-hardened)
   *   - Token must carry `sub` (user id) and `sid` (session id).
   *   - Session is looked up server-side; expired/mismatched sessions → 401.
   *   - The handler reads `req.user.sub` (preferred) or `req.user.id`.
   *
   * Request body: { currentPassword: string, newPassword: string }
   *
   * Success contract:
   *   200 { ok: true, message: 'Password updated successfully' }
   *   - `password_hash` is replaced with a fresh scrypt hash.
   *   - ALL sessions for the user are invalidated (logout-everywhere).
   *
   * Failure contract (AppError via global errorHandler):
   *   400 VALIDATION_ERROR  – missing body fields, or newPassword fails
   *                           the strength policy (≥12 chars, mixed case,
   *                           digit, special, not common/sequential).
   *   401 UNAUTHORIZED      – missing/invalid Bearer token, unknown/expired
   *                           session, or currentPassword does not match.
   *   404 NOT_FOUND         – authenticated user id not present in `users`.
   *   500 INTERNAL_ERROR    – unexpected DB/transaction failure.
   */
  router.post('/me/change-password', opts.requireAuth, handler);
  router.patch('/me/password', opts.requireAuth, handler);

  return router;
}