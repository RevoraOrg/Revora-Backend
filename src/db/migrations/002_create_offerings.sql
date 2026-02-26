-- Migration: Create offerings table
CREATE TABLE IF NOT EXISTS offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  target_amount VARCHAR(255) NOT NULL, -- Decimal as string to preserve precision
  min_investment VARCHAR(255) NOT NULL,
  max_investment VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'active', -- active, closed, cancelled
  issuer_id UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index on issuer_id for faster queries
CREATE INDEX IF NOT EXISTS idx_offerings_issuer_id ON offerings(issuer_id);

-- Create index on status for faster queries
CREATE INDEX IF NOT EXISTS idx_offerings_status ON offerings(status);

-- Create index on created_at for faster queries
CREATE INDEX IF NOT EXISTS idx_offerings_created_at ON offerings(created_at);
