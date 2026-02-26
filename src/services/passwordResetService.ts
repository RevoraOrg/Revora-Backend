import { Pool, PoolClient } from 'pg';
import { randomBytes, createHash } from 'node:crypto';

export type EmailSender = (to: string, subject: string, body: string) => Promise<void>;

export interface PasswordResetServiceOptions {
  emailSender?: EmailSender;
  tokenTtlMinutes?: number;
  appUrl?: string;
}

export class PasswordResetService {
  private emailSender: EmailSender;
  private tokenTtlMinutes: number;
  private appUrl: string;

  constructor(private readonly db: Pool, opts?: PasswordResetServiceOptions) {
    this.emailSender = opts?.emailSender ?? (async (_to, _subject, _body) => {});
    this.tokenTtlMinutes = opts?.tokenTtlMinutes ?? 60;
    this.appUrl = opts?.appUrl ?? process.env.APP_URL ?? 'http://localhost:3000';
  }

  async requestPasswordReset(emailRaw: string): Promise<void> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.findUserByEmail(email);
    if (!user) {
      return;
    }

    const token = this.generateToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + this.tokenTtlMinutes * 60_000);

    await this.db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt],
    );

    const resetLink = `${this.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.emailSender(
      user.email,
      'Password Reset',
      `Use this link to reset your password: ${resetLink}`,
    );
  }

  async resetPassword(tokenRaw: string, newPassword: string): Promise<boolean> {
    const tokenHash = this.hashToken(tokenRaw);
    let client: PoolClient | null = null;
    try {
      client = await this.db.connect();
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT id, user_id, expires_at, used_at
         FROM password_reset_tokens
         WHERE token_hash = $1
         FOR UPDATE`,
        [tokenHash],
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      const row = rows[0] as { id: string; user_id: string; expires_at: Date; used_at: Date | null };
      if (row.used_at || new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return false;
      }

      const passwordHash = this.hashPassword(newPassword);

      await client.query(
        `UPDATE users SET password_hash = $1 WHERE id = $2`,
        [passwordHash, row.user_id],
      );

      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [row.id],
      );

      await client.query('COMMIT');
      return true;
    } catch {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      throw new Error('Password reset failed');
    } finally {
      client?.release();
    }
  }

  private async findUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
    const { rows } = await this.db.query(
      `SELECT id, email FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [email],
    );
    if (rows.length === 0) return null;
    return { id: rows[0].id, email: rows[0].email };
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private hashPassword(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex');
  }
}

