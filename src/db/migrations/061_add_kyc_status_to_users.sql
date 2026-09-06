-- Migration: Add KYC verification status columns to users
-- Description: Persists the authoritative KYC/AML verification state per
--              investor so the investment flow can gate submissions until a
--              provider reports `approved`. Also stores the provider name and
--              provider transaction/reference id to keep an auditable link
--              between an investor's record and the external KYC/AML check.
--
-- Statuses: pending | in_review | approved | rejected
-- Migration is additive and backward compatible:
--   * existing rows default to 'pending' (previous behaviour: no gate),
--   * dropping the gate flag in app config restores legacy behaviour.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_status VARCHAR(20) NOT NULL DEFAULT 'pending';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_provider TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_reference_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'users_kyc_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_kyc_status_check
      CHECK (kyc_status IN ('pending', 'in_review', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_kyc_status ON users (kyc_status);