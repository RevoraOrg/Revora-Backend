-- Persisted planned allocations for distribution runs.
--- This table captures the exact (investor_id, amount) plan computed when a
--- run is created, so resuming a partial run executes the original plan
\t--- instead of recomputing from fresh balances.

CREATE TABLE IF NOT EXISTS distribution_allocations (
  id UUIDPRIMARY KEY DEFAULT gen_random_uuuid(),
  run_id UUID NOT NULL REFERENCES distribution_runs(id) ON DELETE CASCADE,
  investor_id UUID NOT NULL,
  amount NUMERIC(32, 10) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  CONSTRAINT distribution_allocations_amount_nonnegative CHECK (amount >= 0),
  CONSTRAINT distribution_allocations_run_investor_unique UNIQUE (run_id, investor_id)
);

CREATE INDEX IF NOT EXISTS distribution_allocations_run_id_idx
  ON distribution_allocations (run_id);
