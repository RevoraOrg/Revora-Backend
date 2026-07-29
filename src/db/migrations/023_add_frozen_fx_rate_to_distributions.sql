-- Migration: Add frozen_fx_rate_id to distributions
-- Description: Pins the FX conversion rate for the entire distribution run
-- to prevent mid-run rate changes causing reconciliation churn.

ALTER TABLE distributions
  ADD COLUMN frozen_fx_rate_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_distributions_frozen_fx_rate
  ON distributions (frozen_fx_rate_id);
