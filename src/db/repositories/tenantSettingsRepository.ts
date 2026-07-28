import { Pool, QueryResult } from 'pg';

export interface TenantSettingsRow {
  tenant_id: string;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export class TenantSettingsRepository {
  constructor(private readonly db: Pool) {}

  async findByTenantId(tenantId: string): Promise<TenantSettingsRow | null> {
    const result: QueryResult = await this.db.query(
      `SELECT tenant_id, settings, created_at, updated_at
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

  async upsertSettings(tenantId: string, settings: Record<string, unknown>): Promise<TenantSettingsRow> {
    const result: QueryResult = await this.db.query(
      `INSERT INTO tenant_settings (tenant_id, settings, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (tenant_id)
       DO UPDATE SET settings = $2, updated_at = NOW()
       RETURNING tenant_id, settings, created_at, updated_at`,
      [tenantId, JSON.stringify(settings)],
    );

    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: any): TenantSettingsRow {
    return {
      tenant_id: row.tenant_id,
      settings: row.settings ?? {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
