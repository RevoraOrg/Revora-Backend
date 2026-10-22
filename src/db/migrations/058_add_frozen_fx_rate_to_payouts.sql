-- Migration: Add frozen_fx_rate_id to distribution_payouts
-- Description: Stores the pinned FX rate on each payout record to maintain
-- audit integrity and prevent reconciliation churn.

ALTER TABLE distribution_payouts
  ADD COLUMN IF NOT EXISTS frozen_fx_rate_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_distribution_payouts_frozen_fx_rate
  ON distribution_payouts (frozen_fx_rate_id);
