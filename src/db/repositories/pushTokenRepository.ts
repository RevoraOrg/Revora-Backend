import { Pool, QueryResult } from 'pg';

/**
 * Push token entity — represents a device registration token for FCM or APNs.
 */
export interface PushToken {
  id: string;
  user_id: string;
  token: string;
  provider: 'fcm' | 'apns';
  status: 'active' | 'pruned' | 'expired';
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type PushTokenProvider = 'fcm' | 'apns';
export type PushTokenStatus = 'active' | 'pruned' | 'expired';

export interface CreatePushTokenInput {
  user_id: string;
  token: string;
  provider: PushTokenProvider;
}

export interface PushTokenRepository {
  /** Register (upsert) a device token for a user. */
  upsert(input: CreatePushTokenInput): Promise<PushToken>;

  /** Find all active tokens for a user. */
  findActiveByUser(userId: string): Promise<PushToken[]>;

  /** Find a token by its raw token string. */
  findByToken(token: string): Promise<PushToken | null>;

  /** Mark a token as pruned (device uninstalled / 410 from provider). */
  markPruned(tokenId: string): Promise<PushToken | null>;

  /** Mark a token as expired. */
  markExpired(tokenId: string): Promise<PushToken | null>;

  /** Count active tokens for metrics. */
  countActive(): Promise<number>;

  /** Count pruned tokens for metrics. */
  countPruned(): Promise<number>;
}

/**
 * PostgreSQL-backed push token repository.
 *
 * Security assumptions:
 * - Token values are opaque strings from FCM/APNs and are stored as-is.
 * - No PII is stored in this table beyond the user_id foreign key.
 * - Token strings are unique-constrained to prevent duplicate registrations.
 */
export class PgPushTokenRepository implements PushTokenRepository {
  constructor(private readonly db: Pool) {}

  async upsert(input: CreatePushTokenInput): Promise<PushToken> {
    const query = `
      INSERT INTO push_tokens (user_id, token, provider, status, last_used_at)
      VALUES ($1, $2, $3, 'active', NOW())
      ON CONFLICT (token)
      DO UPDATE SET
        user_id     = EXCLUDED.user_id,
        provider    = EXCLUDED.provider,
        status      = 'active',
        last_used_at = NOW(),
        updated_at  = NOW()
      RETURNING *
    `;
    const result: QueryResult<Record<string, unknown>> = await this.db.query(query, [
      input.user_id,
      input.token,
      input.provider,
    ]);
    if (result.rows.length === 0) {
      throw new Error('Failed to upsert push token');
    }
    return this.mapRow(result.rows[0]);
  }

  async findActiveByUser(userId: string): Promise<PushToken[]> {
    const query = `
      SELECT * FROM push_tokens
      WHERE user_id = $1 AND status = 'active'
      ORDER BY last_used_at DESC
    `;
    const result: QueryResult<Record<string, unknown>> = await this.db.query(query, [userId]);
    return result.rows.map((row) => this.mapRow(row));
  }

  async findByToken(token: string): Promise<PushToken | null> {
    const query = `
      SELECT * FROM push_tokens
      WHERE token = $1
      LIMIT 1
    `;
    const result: QueryResult<Record<string, unknown>> = await this.db.query(query, [token]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async markPruned(tokenId: string): Promise<PushToken | null> {
    const query = `
      UPDATE push_tokens
      SET status = 'pruned', updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result: QueryResult<Record<string, unknown>> = await this.db.query(query, [tokenId]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async markExpired(tokenId: string): Promise<PushToken | null> {
    const query = `
      UPDATE push_tokens
      SET status = 'expired', updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result: QueryResult<Record<string, unknown>> = await this.db.query(query, [tokenId]);
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]);
  }

  async countActive(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM push_tokens WHERE status = 'active'`
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  async countPruned(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM push_tokens WHERE status = 'pruned'`
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private mapRow(row: Record<string, unknown>): PushToken {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      token: row.token as string,
      provider: row.provider as PushTokenProvider,
      status: row.status as PushTokenStatus,
      last_used_at: row.last_used_at as Date | null,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }
}

/**
 * In-memory push token repository for testing.
 */
export class InMemoryPushTokenRepository implements PushTokenRepository {
  private tokens: Map<string, PushToken> = new Map();
  private idCounter = 0;

  async upsert(input: CreatePushTokenInput): Promise<PushToken> {
    // Check for existing token
    for (const t of this.tokens.values()) {
      if (t.token === input.token) {
        t.user_id = input.user_id;
        t.provider = input.provider;
        t.status = 'active';
        t.last_used_at = new Date();
        t.updated_at = new Date();
        return { ...t };
      }
    }
    const token: PushToken = {
      id: `pt-${++this.idCounter}`,
      user_id: input.user_id,
      token: input.token,
      provider: input.provider,
      status: 'active',
      last_used_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.tokens.set(token.id, token);
    return { ...token };
  }

  async findActiveByUser(userId: string): Promise<PushToken[]> {
    return Array.from(this.tokens.values()).filter(
      (t) => t.user_id === userId && t.status === 'active'
    );
  }

  async findByToken(token: string): Promise<PushToken | null> {
    for (const t of this.tokens.values()) {
      if (t.token === token) return { ...t };
    }
    return null;
  }

  async markPruned(tokenId: string): Promise<PushToken | null> {
    const t = this.tokens.get(tokenId);
    if (!t) return null;
    t.status = 'pruned';
    t.updated_at = new Date();
    this.tokens.set(tokenId, t);
    return { ...t };
  }

  async markExpired(tokenId: string): Promise<PushToken | null> {
    const t = this.tokens.get(tokenId);
    if (!t) return null;
    t.status = 'expired';
    t.updated_at = new Date();
    this.tokens.set(tokenId, t);
    return { ...t };
  }

  async countActive(): Promise<number> {
    return Array.from(this.tokens.values()).filter((t) => t.status === 'active').length;
  }

  async countPruned(): Promise<number> {
    return Array.from(this.tokens.values()).filter((t) => t.status === 'pruned').length;
  }
}
