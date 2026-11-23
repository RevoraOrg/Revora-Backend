-- Migration: create oidc_group_mappings table for group-to-role mappings
CREATE TABLE IF NOT EXISTS oidc_group_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(64)  NOT NULL REFERENCES oidc_providers(tenant_id) ON DELETE CASCADE,
  claim_group  VARCHAR(255) NOT NULL,
  revora_role  VARCHAR(50)  NOT NULL CHECK (revora_role IN ('startup','investor')),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, claim_group)
);

CREATE INDEX IF NOT EXISTS idx_oidc_group_mappings_tenant_id ON oidc_group_mappings (tenant_id);
