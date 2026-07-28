-- Migration: create contract_upgrades table for Soroban contract upgrade orchestration

CREATE TABLE IF NOT EXISTS contract_upgrades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(64) NOT NULL,
  contract_id VARCHAR(128) NOT NULL,
  target_code_id VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('pending', 'approved', 'applied', 'failed')),
  proposed_by UUID NOT NULL,
  approved_by UUID NULL,
  simulate_result JSONB NULL,
  simulate_ok BOOLEAN NULL,
  transaction_hash VARCHAR(128) NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE NULL,
  applied_at TIMESTAMP WITH TIME ZONE NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contract_upgrades_tenant_id ON contract_upgrades(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_upgrades_contract_id ON contract_upgrades(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_upgrades_status ON contract_upgrades(status);
