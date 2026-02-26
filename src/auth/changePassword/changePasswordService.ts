import { hashPassword, comparePassword as verifyPassword } from '../../utils/password';

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
  constructor(private readonly userRepo: ChangePasswordUserRepo) {}

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

    if (!newPassword || newPassword.length < 8) {
      return {
        ok: false,
        reason: 'VALIDATION_ERROR',
        message: 'newPassword must be at least 8 characters.',
      };
    }

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

    // Hash and persist
    const newHash = await hashPassword(newPassword);
    await this.userRepo.updatePasswordHash(userId, newHash);

    return { ok: true };
  }
}