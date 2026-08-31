-- Migration: create tenant_settings table for per-tenant configuration

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id VARCHAR(64) PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_settings_tenant_id ON tenant_settings(tenant_id);
