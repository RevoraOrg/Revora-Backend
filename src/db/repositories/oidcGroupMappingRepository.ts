import { Pool, QueryResult } from 'pg';

export interface OidcGroupMappingRow {
  id: string;
  tenant_id: string;
  claim_group: string;
  revora_role: 'startup' | 'investor';
  created_at: Date;
}

export interface CreateOidcGroupMappingInput {
  tenantId: string;
  claimGroup: string;
  revoraRole: 'startup' | 'investor';
}

export class OidcGroupMappingRepository {
  constructor(private db: Pool) {}

  async create(input: CreateOidcGroupMappingInput): Promise<OidcGroupMappingRow> {
    const query = `
      INSERT INTO oidc_group_mappings (tenant_id, claim_group, revora_role, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;
    const result: QueryResult<OidcGroupMappingRow> = await this.db.query(query, [
      input.tenantId,
      input.claimGroup,
      input.revoraRole,
    ]);
    return result.rows[0];
  }

  async findByTenantId(tenantId: string): Promise<OidcGroupMappingRow[]> {
    const query = `
      SELECT id, tenant_id, claim_group, revora_role, created_at
      FROM oidc_group_mappings
      WHERE tenant_id = $1
    `;
    const result: QueryResult<OidcGroupMappingRow> = await this.db.query(query, [tenantId]);
    return result.rows;
  }

  async deleteByTenantAndGroup(tenantId: string, claimGroup: string): Promise<boolean> {
    const query = `
      DELETE FROM oidc_group_mappings
      WHERE tenant_id = $1 AND claim_group = $2
    `;
    const result = await this.db.query(query, [tenantId, claimGroup]);
    return (result.rowCount ?? 0) > 0;
  }
}
