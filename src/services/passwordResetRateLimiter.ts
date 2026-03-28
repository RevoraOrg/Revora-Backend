import { Pool } from 'pg';

export interface RateLimitConfig {
  maxRequests: number;
  windowMinutes: number;
  blockMinutes: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remainingRequests: number;
  resetAt: Date;
  retryAfter?: number;
}

export class PasswordResetRateLimiter {
  private readonly maxRequests: number;
  private readonly windowMinutes: number;
  private readonly blockMinutes: number;

  constructor(
    private readonly db: Pool,
    config?: Partial<RateLimitConfig>
  ) {
    this.maxRequests = config?.maxRequests ?? 3;
    this.windowMinutes = config?.windowMinutes ?? 60;
    this.blockMinutes = config?.blockMinutes ?? 15;
  }

  async checkRateLimit(identifier: string): Promise<RateLimitResult> {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    
    const isBlocked = await this.checkIfBlocked(normalizedIdentifier);
    if (isBlocked) {
      const blockExpiry = await this.getBlockExpiry(normalizedIdentifier);
      const retryAfter = blockExpiry 
        ? Math.ceil((blockExpiry.getTime() - Date.now()) / 1000)
        : this.blockMinutes * 60;
      
      return {
        allowed: false,
        remainingRequests: 0,
        resetAt: blockExpiry ?? new Date(Date.now() + this.blockMinutes * 60_000),
        retryAfter: Math.max(0, retryAfter),
      };
    }

    const { count, windowStart } = await this.getRequestCount(normalizedIdentifier);
    const remainingRequests = Math.max(0, this.maxRequests - count);
    const resetAt = new Date(windowStart.getTime() + this.windowMinutes * 60_000);

    if (count >= this.maxRequests) {
      await this.blockIdentifier(normalizedIdentifier);
      return {
        allowed: false,
        remainingRequests: 0,
        resetAt,
        retryAfter: this.blockMinutes * 60,
      };
    }

    await this.recordRequest(normalizedIdentifier);
    
    return {
      allowed: true,
      remainingRequests: remainingRequests - 1,
      resetAt,
    };
  }

  async resetRateLimit(identifier: string): Promise<void> {
    const normalizedIdentifier = this.normalizeIdentifier(identifier);
    await this.db.query(
      `DELETE FROM password_reset_rate_limits WHERE identifier = $1`,
      [normalizedIdentifier]
    );
  }

  private normalizeIdentifier(identifier: string): string {
    return identifier.trim().toLowerCase();
  }

  private async checkIfBlocked(identifier: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT blocked_until FROM password_reset_rate_limits 
       WHERE identifier = $1 AND blocked_until > NOW()`,
      [identifier]
    );
    return rows.length > 0;
  }

  private async getBlockExpiry(identifier: string): Promise<Date | null> {
    const { rows } = await this.db.query(
      `SELECT blocked_until FROM password_reset_rate_limits 
       WHERE identifier = $1 AND blocked_until > NOW()`,
      [identifier]
    );
    return rows.length > 0 ? rows[0].blocked_until : null;
  }

  private async getRequestCount(identifier: string): Promise<{ count: number; windowStart: Date }> {
    const windowStart = new Date(Date.now() - this.windowMinutes * 60_000);
    
    const { rows } = await this.db.query(
      `SELECT COUNT(*) as count FROM password_reset_rate_limits 
       WHERE identifier = $1 AND request_at > $2`,
      [identifier, windowStart]
    );
    
    return {
      count: parseInt(rows[0]?.count ?? '0', 10),
      windowStart,
    };
  }

  private async recordRequest(identifier: string): Promise<void> {
    await this.db.query(
      `INSERT INTO password_reset_rate_limits (identifier, request_at) VALUES ($1, NOW())`,
      [identifier]
    );
  }

  private async blockIdentifier(identifier: string): Promise<void> {
    const blockedUntil = new Date(Date.now() + this.blockMinutes * 60_000);
    
    await this.db.query(
      `INSERT INTO password_reset_rate_limits (identifier, blocked_until, request_at) 
       VALUES ($1, $2, NOW())
       ON CONFLICT (identifier) DO UPDATE SET blocked_until = $2, request_at = NOW()`,
      [identifier, blockedUntil]
    );
  }
}
