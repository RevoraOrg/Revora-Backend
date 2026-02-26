-- Migration: Create investments table
CREATE TABLE IF NOT EXISTS investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES offerings(id),
  investor_id UUID NOT NULL,
  amount VARCHAR(255) NOT NULL, -- Decimal as string to preserve precision
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, confirmed, cancelled
  transaction_hash VARCHAR(255), -- Stellar transaction hash (optional for now)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on offering_id for faster queries
CREATE INDEX IF NOT EXISTS idx_investments_offering_id ON investments(offering_id);

-- Create index on investor_id for faster queries
CREATE INDEX IF NOT EXISTS idx_investments_investor_id ON investments(investor_id);

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_investments_status ON investments(status);

-- Create index on created_at for faster queries
CREATE INDEX IF NOT EXISTS idx_investments_created_at ON investments(created_at);
