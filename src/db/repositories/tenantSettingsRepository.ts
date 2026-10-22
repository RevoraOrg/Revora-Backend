import { Pool, PoolClient, QueryResult } from 'pg';
import { withTransaction } from '../transaction';

export interface TenantSettingsRow {
  tenant_id: string;
  settings: Record<string, unknown>;
  session_policy: 'lax' | 'strict';
  created_at: Date;
  updated_at: Date;
}

export class TenantSettingsRepository {
  constructor(private readonly db: Pool) {}

  withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.db, callback);
  }

  async findByTenantId(tenantId: string): Promise<TenantSettingsRow | null> {
    const result: QueryResult = await this.db.query(
      `SELECT tenant_id, settings, session_policy, created_at, updated_at
       FROM tenant_settings
       WHERE tenant_id = $1
       LIMIT 1`,
      [tenantId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRow(result.rows[0]);
  }

  /**
   * Updates tenant settings without modifying the session policy.
   * On conflict, only settings and updated_at are updated; session_policy is left untouched.
   *
   * @param tenantId Target tenant identifier
   * @param settings Arbitrary settings dictionary to persist
   * @returns Updated tenant settings record
   */
  async updateSettings(tenantId: string, settings: Record<string, unknown>): Promise<TenantSettingsRow> {
    const result: QueryResult = await this.db.query(
      `INSERT INTO tenant_settings (tenant_id, settings, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()
       RETURNING tenant_id, settings, session_policy, created_at, updated_at`,
      [tenantId, JSON.stringify(settings)],
    );

    return this.mapRow(result.rows[0]);
  }

  /**
   * Sets the session policy for a tenant without modifying existing settings.
   * On conflict, only session_policy and updated_at are updated; settings are left untouched.
   *
   * @param tenantId Target tenant identifier
   * @param policy Desired session policy ('lax' | 'strict')
   * @returns Updated tenant settings record
   */
  async setSessionPolicy(tenantId: string, policy: 'lax' | 'strict'): Promise<TenantSettingsRow> {
    const result: QueryResult = await this.db.query(
      `INSERT INTO tenant_settings (tenant_id, session_policy, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET session_policy = EXCLUDED.session_policy, updated_at = NOW()
       RETURNING tenant_id, settings, session_policy, created_at, updated_at`,
      [tenantId, policy],
    );

    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): TenantSettingsRow {
    return {
      tenant_id: row.tenant_id,
      settings: row.settings ?? {},
      session_policy: row.session_policy as 'lax' | 'strict',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
