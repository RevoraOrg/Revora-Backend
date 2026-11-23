-- Migration: Create investments table
-- Description: Adds database tables for investments (investor, offering, amount, asset, status, tx_hash, created_at, etc.)

CREATE TABLE IF NOT EXISTS investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investor_id UUID NOT NULL,
  offering_id UUID NOT NULL,
  amount NUMERIC(30, 10) NOT NULL,
  asset VARCHAR(255) NOT NULL, -- e.g. token code or address
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, completed, failed
  tx_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_investments_offering_id ON investments (offering_id);
CREATE INDEX IF NOT EXISTS idx_investments_investor_id ON investments (investor_id);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_investments_updated_at
    BEFORE UPDATE ON investments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
