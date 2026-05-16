import { Pool, PoolClient } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword as hashUserPassword } from '../utils/password';
import { logger } from '../lib/logger';
import { PasswordResetTokenInvalidError, Errors } from '../lib/errors';

export type EmailSender = (to: string, subject: string, body: string) => Promise<void>;

export interface PasswordResetServiceOptions {
  emailSender?: EmailSender;
  tokenTtlMinutes?: number;
  appUrl?: string;
}

export class PasswordResetService {
  private readonly emailSender: EmailSender;
  private readonly tokenTtlMinutes: number;
  private readonly appUrl: string;

  constructor(private readonly db: Pool, opts?: PasswordResetServiceOptions) {
    this.emailSender = opts?.emailSender ?? (async () => {});
    this.tokenTtlMinutes = opts?.tokenTtlMinutes ?? 15;
    this.appUrl = opts?.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000';
  }

  async requestPasswordReset(emailRaw: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.findUserByEmail(email);

    if (!user) {
      logger.info('Password reset request for unknown user', {
        event: 'password_reset_unknown_email',
      });
      return;
    }

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.tokenTtlMinutes * 60_000);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
        [user.id],
      );
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to create password reset token', { error });
      throw Errors.internal('Unable to process password reset request');
    } finally {
      client.release();
    }

    logger.info('Password reset token issued', {
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
    });

    await this.emailSender(
      user.email,
      'Password reset request',
      `Use this secure token to reset your password: ${token}`,
    );
  }

  async resetPassword(tokenRaw: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(tokenRaw.trim());
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT id, user_id, expires_at, used
         FROM password_reset_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('Password reset attempt failed: invalid token', {
          event: 'password_reset_invalid_token',
        });
        throw new PasswordResetTokenInvalidError();
      }

      const row = rows[0] as {
        id: string;
        user_id: string;
        expires_at: Date;
        used: boolean;
      };

      if (row.used) {
        await client.query('ROLLBACK');
        logger.warn('Password reset attempt failed: token already used', {
          event: 'password_reset_used_token',
          userId: row.user_id,
        });
        throw new PasswordResetTokenInvalidError();
      }

      if (new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        logger.warn('Password reset attempt failed: token expired', {
          event: 'password_reset_expired_token',
          userId: row.user_id,
        });
        throw new PasswordResetTokenInvalidError();
      }

      await client.query(
        `UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`,
        [row.id],
      );

      const passwordHash = await hashUserPassword(newPassword);
      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, row.user_id],
      );
      await client.query('COMMIT');

      logger.info('Password reset token used', {
        userId: row.user_id,
        tokenId: row.id,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof PasswordResetTokenInvalidError) {
        throw error;
      }

      logger.error('Password reset failed', { error });
      throw Errors.internal('Unable to reset password');
    } finally {
      client.release();
    }
  }

  private async findUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
    const { rows } = await this.db.query(
      `SELECT id, email FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email],
    );

    if (rows.length === 0) {
      return null;
    }

    return { id: rows[0].id, email: rows[0].email };
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}

