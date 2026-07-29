-- Migration: AML investment velocity sliding-window aggregate
-- Description: Provides per-investor sliding-window aggregates used by the
--              AML velocity rule to detect smurfing (many small deposits over
--              a short window).  Indexed on (investor_id, window_end) so the
--              rule evaluator can efficiently query recent windows.
--
-- DOWN Migration (manual rollback):
--   DROP INDEX  IF EXISTS idx_aml_investment_velocity_investor_window;
--   DROP INDEX  IF EXISTS idx_aml_investment_velocity_investor_id;
--   DROP TABLE  IF EXISTS aml_investment_velocity;

CREATE TABLE IF NOT EXISTS aml_investment_velocity (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Investor this aggregate belongs to.
  investor_id      UUID        NOT NULL,

  -- Closed window bounds (UTC).  The window is [window_start, window_end).
  -- window_end = timestamp of the triggering investment.
  -- window_start = window_end - window_minutes * interval '1 minute'.
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,

  -- Window length in minutes (mirrors rule config so the row is self-describing).
  window_minutes   INTEGER     NOT NULL CHECK (window_minutes > 0),

  -- Aggregate values inside the window.
  tx_count         INTEGER     NOT NULL CHECK (tx_count >= 0),
  total_amount     NUMERIC(30, 10) NOT NULL CHECK (total_amount >= 0),

  -- IDs of the individual investments that contributed to this aggregate.
  -- Stored as a JSONB array of UUIDs for audit trail.
  investment_ids   JSONB       NOT NULL DEFAULT '[]',

  -- Whether the velocity thresholds were exceeded for this window.
  amount_exceeded  BOOLEAN     NOT NULL DEFAULT FALSE,
  count_exceeded   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Snapshot of the configured thresholds at evaluation time.
  threshold_amount NUMERIC(30, 10) NULL,
  threshold_count  INTEGER     NULL,

  -- The AML rule that produced this aggregate.
  rule_id          TEXT        NOT NULL,
  rule_version     JSONB       NOT NULL DEFAULT '{}',

  -- Standard audit timestamps.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Prevent duplicate rows for the same investor + window + rule combination.
  CONSTRAINT uq_aml_velocity_investor_window_rule
    UNIQUE (investor_id, window_start, window_end, rule_id),

  CONSTRAINT chk_window_order CHECK (window_end > window_start)
);

-- Primary lookup: find recent windows for an investor ordered by recency.
CREATE INDEX IF NOT EXISTS idx_aml_investment_velocity_investor_window
  ON aml_investment_velocity (investor_id, window_end DESC);

-- Secondary: filter by investor alone.
CREATE INDEX IF NOT EXISTS idx_aml_investment_velocity_investor_id
  ON aml_investment_velocity (investor_id);

-- Trigger to keep updated_at current.
DROP TRIGGER IF EXISTS update_aml_investment_velocity_updated_at ON aml_investment_velocity;
CREATE TRIGGER update_aml_investment_velocity_updated_at
  BEFORE UPDATE ON aml_investment_velocity
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
