-- Migration: Create payout_drift_reports table
-- Description: Persists nightly payout drift snapshots comparing the
-- distribution_payouts table against indexed on-chain Stellar payments.
-- Each row captures a single drift detection run, with per-offering
-- breakdowns of missing, under-funded, over-funded, and duplicate payments.

CREATE TABLE IF NOT EXISTS payout_drift_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  offering_id UUID NOT NULL,
  total_payouts INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  missing_count INTEGER NOT NULL DEFAULT 0,
  underfunded_count INTEGER NOT NULL DEFAULT 0,
  overfunded_count INTEGER NOT NULL DEFAULT 0,
  duplicate_tx_count INTEGER NOT NULL DEFAULT 0,
  total_drift_amount NUMERIC(30, 10) NOT NULL DEFAULT 0,
  oldest_drift_age_hours NUMERIC(10, 2) DEFAULT 0,
  details JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(50) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'error')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_drift_reports_run_at ON payout_drift_reports (run_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_drift_reports_offering_id ON payout_drift_reports (offering_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_drift_reports_status ON payout_drift_reports (status);
