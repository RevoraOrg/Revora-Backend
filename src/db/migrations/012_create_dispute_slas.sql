-- Migration: create dispute_slas table
-- Tracks SLA timers per dispute state with pause/resume support
-- and escalation tracking for regulatory compliance

CREATE TABLE IF NOT EXISTS dispute_slas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL,
  jurisdiction VARCHAR(50) NOT NULL,
  state VARCHAR(50) NOT NULL,
  sla_duration_hours INTEGER NOT NULL CHECK (sla_duration_hours > 0),
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMP WITH TIME ZONE,
  total_paused_ms BIGINT NOT NULL DEFAULT 0,
  escalated_at TIMESTAMP WITH TIME ZONE,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at TIMESTAMP WITH TIME ZONE,
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_slas_dispute_id ON dispute_slas(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_slas_state ON dispute_slas(state);
CREATE INDEX IF NOT EXISTS idx_dispute_slas_escalated ON dispute_slas(escalated);
CREATE INDEX IF NOT EXISTS idx_dispute_slas_jurisdiction ON dispute_slas(jurisdiction);
CREATE INDEX IF NOT EXISTS idx_dispute_slas_started_at ON dispute_slas(started_at);

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_dispute_slas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dispute_slas_updated_at ON dispute_slas;
CREATE TRIGGER trg_dispute_slas_updated_at
  BEFORE UPDATE ON dispute_slas
  FOR EACH ROW
  EXECUTE FUNCTION update_dispute_slas_updated_at();
