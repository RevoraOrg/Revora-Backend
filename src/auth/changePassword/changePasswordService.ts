import { hashPassword, comparePassword as verifyPassword } from '../../utils/password';
import { validatePasswordStrength } from '../../lib/passwordStrength';
import { Pool } from 'pg';
import { withTransaction } from '../../db/transaction';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { Logger } from '../../lib/logger';

// ── Port interface ────────────────────────────────────────────────────────────
// Keeps the service decoupled from pg and the concrete UserRepository.
export interface ChangePasswordUserRepo {
  findUserById(id: string): Promise<{ id: string; password_hash: string } | null>;
  updatePasswordHash(userId: string, newHash: string): Promise<void>;
}

// ── Input / Output types ──────────────────────────────────────────────────────
export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
}

export type ChangePasswordResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'USER_NOT_FOUND' | 'WRONG_PASSWORD' | 'VALIDATION_ERROR';
      message: string;
    };

// ── Service ───────────────────────────────────────────────────────────────────
export class ChangePasswordService {
  constructor(
    private readonly userRepo: ChangePasswordUserRepo,
    private readonly sessionRepo: SessionRepository,
    private readonly db: Pool,
    private readonly logger: Logger = new Logger({ serviceName: 'change-password' })
  ) {}

  async execute(input: ChangePasswordInput): Promise<ChangePasswordResult> {
    const { userId, currentPassword, newPassword } = input;

    // Validate inputs first (cheap, no DB hit)
    if (!currentPassword) {
      return {
        ok: false,
        reason: 'VALIDATION_ERROR',
        message: 'currentPassword is required.',
      };
    }

    // Validate new password strength
    const strength = validatePasswordStrength(newPassword);
    if (!strength.isValid) {
      return {
        ok: false,
        reason: 'VALIDATION_ERROR',
        message: `New password does not meet strength requirements: ${strength.errors.join(', ')}`,
      };
    }

    // Execute password change and session invalidation in a transaction
    return withTransaction(this.db, async (client) => {
      // Load user
      const user = await this.userRepo.findUserById(userId);
      if (!user) {
        return { ok: false, reason: 'USER_NOT_FOUND', message: 'User not found.' };
      }

      // Verify current password using scrypt timing-safe compare (src/lib/hash.ts)
      const isMatch = await verifyPassword(currentPassword, user.password_hash);
      if (!isMatch) {
        return {
          ok: false,
          reason: 'WRONG_PASSWORD',
          message: 'Current password is incorrect.',
        };
      }

      // Hash and persist new password
      const newHash = await hashPassword(newPassword);
      await this.userRepo.updatePasswordHash(userId, newHash);

      // Invalidate all sessions for security (prevents race condition where
      // a refresh token could be used milliseconds before password change)
      await this.sessionRepo.deleteAllSessionsByUserId(userId, client);

      this.logger.info('Password changed and sessions invalidated', {
        userId,
      });

      return { ok: true };
    }).catch((error) => {
      this.logger.error('Password change failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }
}