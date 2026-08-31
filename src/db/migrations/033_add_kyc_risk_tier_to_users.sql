-- Migration: Add kyc_risk_tier to users (investor profile)
-- Description: Per-investor KYC risk tier used to scale offering investment caps.
--              Cap changes affect only future investment intents — existing
--              investments are never retroactively invalidated.
--
-- Tiers (strictest → loosest for new capital):
--   restricted | high | elevated | standard | low

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_risk_tier VARCHAR(20) NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'users_kyc_risk_tier_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_kyc_risk_tier_check
      CHECK (kyc_risk_tier IN ('low', 'standard', 'elevated', 'high', 'restricted'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_kyc_risk_tier ON users (kyc_risk_tier);
