-- Migration: create push_experiments table for A/B testing push notifications
-- Supports per-tenant experiment allocations with variant tracking and open metrics
-- Enforces legal-content allowlist - required fields cannot vary across variants

CREATE TABLE IF NOT EXISTS push_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(64) NOT NULL,
  experiment_key VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft', -- draft, active, paused, completed
  allocation_strategy VARCHAR(32) NOT NULL DEFAULT 'weighted', -- weighted, uniform
  started_at TIMESTAMP WITH TIME ZONE,
  ended_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_experiment UNIQUE (tenant_id, experiment_key),
  CONSTRAINT chk_status CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  CONSTRAINT chk_allocation CHECK (allocation_strategy IN ('weighted', 'uniform'))
);

CREATE TABLE IF NOT EXISTS push_experiment_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES push_experiments(id) ON DELETE CASCADE,
  variant_key VARCHAR(64) NOT NULL,
  weight INTEGER NOT NULL DEFAULT 50, -- percentage allocation (0-100)
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  data_template JSONB,
  is_control BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_experiment_variant UNIQUE (experiment_id, variant_key),
  CONSTRAINT chk_weight CHECK (weight >= 0 AND weight <= 100)
);

CREATE TABLE IF NOT EXISTS push_experiment_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES push_experiments(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES push_experiment_variants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  assigned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  opened_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT uq_experiment_user UNIQUE (experiment_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_experiment_legal_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(64) NOT NULL,
  field_key VARCHAR(128) NOT NULL, -- e.g., 'disclaimer', 'regulatory_notice'
  required_value TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_field UNIQUE (tenant_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_push_experiments_tenant_id ON push_experiments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_push_experiments_status ON push_experiments(status);
CREATE INDEX IF NOT EXISTS idx_push_experiment_variants_experiment_id ON push_experiment_variants(experiment_id);
CREATE INDEX IF NOT EXISTS idx_push_experiment_assignments_experiment_id ON push_experiment_assignments(experiment_id);
CREATE INDEX IF NOT EXISTS idx_push_experiment_assignments_user_id ON push_experiment_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_push_experiment_legal_allowlist_tenant_id ON push_experiment_legal_allowlist(tenant_id);
