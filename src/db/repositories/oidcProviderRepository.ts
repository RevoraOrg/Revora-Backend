import { Pool } from 'pg';
import { OidcProviderRow } from '../../auth/oidc/types';

export interface CreateOidcProviderInput {
  tenantId: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  clientSecret?: string | null;
  scopes?: string;
  redirectUris: string;
}

export class OidcProviderRepository {
  constructor(private readonly db: Pool) {}

  async create(input: CreateOidcProviderInput): Promise<OidcProviderRow> {
    const { rows } = await this.db.query<OidcProviderRow>(
      `INSERT INTO oidc_providers
         (tenant_id, name, issuer_url, client_id, client_secret, scopes, redirect_uris)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.tenantId,
        input.name,
        input.issuerUrl,
        input.clientId,
        input.clientSecret ?? null,
        input.scopes ?? 'openid profile email',
        input.redirectUris,
      ],
    );
    return rows[0];
  }

  async findByTenantId(tenantId: string): Promise<OidcProviderRow | null> {
    const { rows } = await this.db.query<OidcProviderRow>(
      'SELECT * FROM oidc_providers WHERE tenant_id = $1 AND enabled = TRUE LIMIT 1',
      [tenantId],
    );
    return rows[0] ?? null;
  }

  async findByIssuerUrl(issuerUrl: string): Promise<OidcProviderRow | null> {
    const { rows } = await this.db.query<OidcProviderRow>(
      'SELECT * FROM oidc_providers WHERE issuer_url = $1 AND enabled = TRUE LIMIT 1',
      [issuerUrl],
    );
    return rows[0] ?? null;
  }

  async findAll(): Promise<OidcProviderRow[]> {
    const { rows } = await this.db.query<OidcProviderRow>(
      'SELECT * FROM oidc_providers ORDER BY created_at DESC',
    );
    return rows;
  }
}
