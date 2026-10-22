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

  async findByTenantIdForUpdate(
    tenantId: string,
    client: PoolClient,
  ): Promise<TenantSettingsRow | null> {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, settings, session_policy, created_at, updated_at)
       VALUES ($1, '{}'::jsonb, 'lax', NOW(), NOW())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
    const result: QueryResult = await client.query(
      `SELECT tenant_id, settings, session_policy, created_at, updated_at
       FROM tenant_settings
       WHERE tenant_id = $1
       LIMIT 1
       FOR UPDATE`,
      [tenantId],
    );
    return result.rows.length > 0 ? this.mapRow(result.rows[0]) : null;
  }

  async upsertSettings(
    tenantId: string,
    settings: Record<string, unknown>,
    sessionPolicy: 'lax' | 'strict' = 'lax',
    client: Pool | PoolClient = this.db,
  ): Promise<TenantSettingsRow> {
    const result: QueryResult = await client.query(
      `INSERT INTO tenant_settings (tenant_id, settings, session_policy, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings = $2, session_policy = $3, updated_at = NOW()
       RETURNING tenant_id, settings, session_policy, created_at, updated_at`,
      [tenantId, JSON.stringify(settings), sessionPolicy],
    );

    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: any): TenantSettingsRow {
    return {
      tenant_id: row.tenant_id,
      settings: row.settings ?? {},
      session_policy: row.session_policy as 'lax' | 'strict',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
