-- Migration: create oidc_providers table for per-tenant SSO configuration
CREATE TABLE IF NOT EXISTS oidc_providers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(64)  NOT NULL UNIQUE,
  name         VARCHAR(128) NOT NULL,
  issuer_url   TEXT         NOT NULL,
  client_id    TEXT         NOT NULL,
  client_secret TEXT,                        -- NULL for public PKCE-only clients
  scopes       TEXT         NOT NULL DEFAULT 'openid profile email',
  redirect_uris TEXT        NOT NULL,        -- comma-separated list
  enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oidc_providers_tenant_id ON oidc_providers (tenant_id);
