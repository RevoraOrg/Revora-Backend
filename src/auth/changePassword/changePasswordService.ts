import { UserRepository } from '../../db/repositories/userRepository';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { hashPassword, comparePassword } from '../../utils/password';

export class ChangePasswordError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'ChangePasswordError';
  }
}

export class ChangePasswordService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly sessionRepository: SessionRepository
  ) {}

  async changePassword(
    userId: string,
    currentSessionId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<void> {
    // 1. Fetch user — needed for password_hash
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new ChangePasswordError('User not found', 404);
    }

    // 2. Verify current password (timing-safe)
    const isMatch = await comparePassword(currentPassword, user.password_hash);
    if (!isMatch) {
      throw new ChangePasswordError('Current password is incorrect', 401);
    }

    // 3. Hash and persist the new password
    const newHash = await hashPassword(newPassword);
    await this.userRepository.updatePasswordHash(userId, newHash);

    // 4. Invalidate ALL sessions for this user (security: force re-login everywhere)
    await this.sessionRepository.deleteAllSessionsByUserId(userId);
  }
}