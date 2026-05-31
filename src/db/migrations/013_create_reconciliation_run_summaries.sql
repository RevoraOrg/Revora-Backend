-- Migration 013: reconciliation_run_summaries
--
-- Persists every scheduler-triggered reconciliation run.
-- Primary key: (offering_id, period_id, started_at) gives a natural composite
-- identity that matches the ReconciliationRunSummary shape in the scheduler.
--
-- Indexes
-- -------
-- idx_rrs_offering_started  — fast lookup of the most-recent run per offering
--   (used by ReconciliationRunStore.getLastRun via ORDER BY started_at DESC LIMIT 1).
-- idx_rrs_balanced          — supports dashboard queries filtering imbalanced runs.

CREATE TABLE IF NOT EXISTS reconciliation_run_summaries (
  offering_id        TEXT        NOT NULL,
  period_id          TEXT        NOT NULL,   -- e.g. "2026-05" (ISO-month)
  started_at         TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ NOT NULL,
  is_balanced        BOOLEAN     NOT NULL,
  discrepancy_count  INTEGER     NOT NULL DEFAULT 0,
  discrepancy_amount NUMERIC(20, 8) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (offering_id, period_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_rrs_offering_started
  ON reconciliation_run_summaries (offering_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_rrs_balanced
  ON reconciliation_run_summaries (is_balanced)
  WHERE is_balanced = FALSE;

COMMENT ON TABLE reconciliation_run_summaries IS
  'One row per ReconciliationScheduler-triggered run. '
  'Keyed by (offering_id, period_id, started_at) so concurrent multi-instance '
  'writes are naturally de-duplicated by the primary key constraint.';
