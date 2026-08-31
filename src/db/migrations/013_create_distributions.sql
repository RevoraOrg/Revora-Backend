-- Migration: Create distributions table
-- Description: Stores distribution runs for offerings, tied to a period and optional tx batch

-- Ensure helper trigger function exists
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

CREATE TABLE IF NOT EXISTS distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  period_id UUID NOT NULL,
  total_amount NUMERIC(30, 10) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tx_batch_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for common queries
CREATE INDEX IF NOT EXISTS idx_distributions_offering_id ON distributions (offering_id);
CREATE INDEX IF NOT EXISTS idx_distributions_period_id ON distributions (period_id);
CREATE INDEX IF NOT EXISTS idx_distributions_status ON distributions (status);
CREATE INDEX IF NOT EXISTS idx_distributions_run_at ON distributions (run_at);

-- Trigger to keep updated_at fresh
DROP TRIGGER IF EXISTS update_distributions_updated_at ON distributions;
CREATE TRIGGER update_distributions_updated_at
    BEFORE UPDATE ON distributions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

