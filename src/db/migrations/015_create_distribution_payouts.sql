-- Migration: Create distribution_payouts table
-- Description: Stores individual payouts produced by a distribution run

-- Ensure helper trigger function exists (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
        CREATE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $func$ LANGUAGE 'plpgsql';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS distribution_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  distribution_id UUID NOT NULL REFERENCES distributions(id) ON DELETE CASCADE,
  investor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount NUMERIC(30, 10) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
  tx_hash VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for common queries
CREATE INDEX IF NOT EXISTS idx_distribution_payouts_distribution_id ON distribution_payouts (distribution_id);
CREATE INDEX IF NOT EXISTS idx_distribution_payouts_investor_id ON distribution_payouts (investor_id);
CREATE INDEX IF NOT EXISTS idx_distribution_payouts_status ON distribution_payouts (status);

-- Trigger to keep updated_at fresh
DROP TRIGGER IF EXISTS update_distribution_payouts_updated_at ON distribution_payouts;
CREATE TRIGGER update_distribution_payouts_updated_at
    BEFORE UPDATE ON distribution_payouts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

