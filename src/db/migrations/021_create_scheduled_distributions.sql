-- Migration: Add deferred distribution scheduling queue
-- Description: Lets operators queue a specific distribution run at a future
--              settlement window. The scheduler picks due rows idempotently and
--              dispatches them through the DistributionEngine with the stored
--              snapshot boundary (period_start / period_end).
--
-- Columns
--   id            UUID primary key
--   offering_id   Offering being distributed (FK -> offerings, cascade delete)
--   period_id     The distribution period this run belongs to (engine idempotency key)
--   period_start  Snapshot boundary start (optional, defaults to run_at)
--   period_end    Snapshot boundary end (optional, defaults to run_at)
--   total_amount  Revenue amount to distribute (NUMERIC, engine requires > 0)
--   run_at        Timestamp at which the run becomes due
--   status        scheduled | processing | completed | failed | cancelled
--   attempts      Incremented on each claim so stale-processing rows are visible
--   error_message Sanitized failure summary (never raw DB/provider errors)
--   created_by    Operator (admin user id) who enqueued the run
--   executed_at   Set when the run completes
--
-- Unique constraint: one pending run per (offering_id, period_id). Duplicate
-- enqueue is rejected with a unique-violation so the scheduler never double-runs
-- the same period, including after a restart.
--
-- DOWN Migration (manual rollback):
--   DROP TABLE IF EXISTS scheduled_distributions;

CREATE TABLE IF NOT EXISTS scheduled_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offering_id UUID NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  period_id UUID NOT NULL,
  period_start TIMESTAMPTZ NULL,
  period_end TIMESTAMPTZ NULL,
  total_amount NUMERIC(30, 10) NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'completed', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NULL,
  created_by UUID NULL,
  executed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (offering_id, period_id)
);

-- Efficiently find due (or stale-processing) rows for the scheduler tick.
CREATE INDEX IF NOT EXISTS idx_scheduled_distributions_due
  ON scheduled_distributions (run_at, status)
  WHERE status IN ('scheduled', 'processing');

-- Operator listing per offering.
CREATE INDEX IF NOT EXISTS idx_scheduled_distributions_offering
  ON scheduled_distributions (offering_id, status);

COMMENT ON TABLE scheduled_distributions IS
  'Queue of operator-approved, deferred distribution runs. Rows are picked by run_at and dispatched idempotently by DistributionScheduler.';
