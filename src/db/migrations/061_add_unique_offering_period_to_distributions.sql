-- Migration: Add unique index on distributions (offering_id, period_id) excluding failed runs
-- Description: Prevents duplicate distribution runs for the same offering and period
--              while allowing retries if a previous run has failed.
--
-- DOWN Migration (manual rollback):
--   DROP INDEX IF EXISTS idx_distributions_offering_period_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_distributions_offering_period_unique
  ON distributions (offering_id, period_id)
  WHERE status != 'failed';
