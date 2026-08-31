-- Migration: create dispute_refunds table
-- Tracks partial refunds on disputes and ledger reversal events

CREATE TABLE IF NOT EXISTS dispute_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL,
  amount NUMERIC(19, 4) NOT NULL CHECK (amount > 0),
  reason TEXT,
  ledger_event_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispute_refunds_dispute_id ON dispute_refunds(dispute_id);
