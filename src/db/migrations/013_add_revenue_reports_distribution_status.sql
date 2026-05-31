-- Migration: Add distribution_status to revenue_reports
-- Description: Adds a per-report distribution state to prevent duplicate scheduler execution.

ALTER TABLE revenue_reports
  ADD COLUMN IF NOT EXISTS distribution_status VARCHAR(50) NULL CHECK (distribution_status IN ('in_progress', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS distribution_status_updated_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_revenue_reports_distribution_status ON revenue_reports (distribution_status);
