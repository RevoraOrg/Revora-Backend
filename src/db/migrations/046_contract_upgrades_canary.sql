-- Migration: extend contract_upgrades for canary phase support
--
-- Adds three new status values:
--   canary_active  – shadow offering is live with the new code-id
--   hold_period    – metrics look clean; waiting out the mandatory hold timer
--   canary_passed  – hold period expired with clean metrics; ready for general rollout
--   rolled_back    – canary was explicitly rolled back before general rollout
--
-- Also adds per-row canary configuration columns so each upgrade can carry its
-- own shadow offering ID, hold duration, and the metrics snapshot collected
-- during the canary window.

-- 1. Drop the existing CHECK constraint by recreating the column default
--    (PostgreSQL does not support ALTER COLUMN … SET CHECK directly; we add
--     a new table-level constraint and drop the old one).

ALTER TABLE contract_upgrades
  DROP CONSTRAINT IF EXISTS contract_upgrades_status_check;

ALTER TABLE contract_upgrades
  ADD CONSTRAINT contract_upgrades_status_check
    CHECK (status IN (
      'pending',
      'approved',
      'applied',
      'failed',
      'canary_active',
      'hold_period',
      'canary_passed',
      'rolled_back'
    ));

-- 2. Canary configuration columns

ALTER TABLE contract_upgrades
  ADD COLUMN IF NOT EXISTS canary_offering_id  VARCHAR(128)  NULL,
  ADD COLUMN IF NOT EXISTS canary_started_at   TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS hold_period_seconds INTEGER       NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS hold_started_at     TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS canary_metrics      JSONB         NULL,
  ADD COLUMN IF NOT EXISTS canary_passed_at    TIMESTAMP WITH TIME ZONE NULL,
  ADD COLUMN IF NOT EXISTS rolled_back_at      TIMESTAMP WITH TIME ZONE NULL;

-- 3. Index to support fast polling of in-flight canary upgrades

CREATE INDEX IF NOT EXISTS idx_contract_upgrades_canary_status
  ON contract_upgrades (status)
  WHERE status IN ('canary_active', 'hold_period');
