CREATE TABLE IF NOT EXISTS token_balance_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL,
  period_id UUID NOT NULL,
  holder_address_or_id VARCHAR(255) NOT NULL,
  balance NUMERIC(30, 10) NOT NULL,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_offering_period
  ON token_balance_snapshots (offering_id, period_id);