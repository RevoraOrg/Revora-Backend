-- Migration: create dispute_ledger_events table
-- Tracks proportional reversals on ledger accounts for disputes

CREATE TABLE IF NOT EXISTS dispute_ledger_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL,
  investor_id UUID NOT NULL,
  amount NUMERIC(19, 4) NOT NULL,
  type VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_ledger_events_dispute_id ON dispute_ledger_events(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_ledger_events_investor_id ON dispute_ledger_events(investor_id);
