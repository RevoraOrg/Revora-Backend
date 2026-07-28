-- Migration: pdf_render_jobs + pdf_render_batches
-- Description: Resumable investor-statement PDF batch pipeline (Issue #540).
--   Jobs are checkpointed in Postgres (status/storage_key/checksum), claimed with
--   FOR UPDATE SKIP LOCKED, and reclaimable after a stale processing window so
--   a crash mid-batch resumes without duplicating durable outputs (deterministic
--   storage_key per investor+period).

CREATE TABLE IF NOT EXISTS pdf_render_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id       TEXT NOT NULL,
  total_jobs      INTEGER NOT NULL DEFAULT 0,
  completed_jobs  INTEGER NOT NULL DEFAULT 0,
  failed_jobs     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pdf_render_batches_period
  ON pdf_render_batches (period_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pdf_render_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES pdf_render_batches(id) ON DELETE CASCADE,
  investor_id     TEXT NOT NULL,
  period_id       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  available_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at      TIMESTAMPTZ,
  -- Deterministic artifact identity: statements/{period_id}/{investor_id}.pdf
  storage_key     TEXT,
  checksum        TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, investor_id, period_id)
);

-- Dispatcher / worker poll: ready pending rows (and reclaim handled in SQL claim)
CREATE INDEX IF NOT EXISTS idx_pdf_render_jobs_pending
  ON pdf_render_jobs (available_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_pdf_render_jobs_processing_claimed
  ON pdf_render_jobs (claimed_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_pdf_render_jobs_batch_status
  ON pdf_render_jobs (batch_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'update_pdf_render_batches_updated_at'
    ) THEN
      CREATE TRIGGER update_pdf_render_batches_updated_at
        BEFORE UPDATE ON pdf_render_batches
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgname = 'update_pdf_render_jobs_updated_at'
    ) THEN
      CREATE TRIGGER update_pdf_render_jobs_updated_at
        BEFORE UPDATE ON pdf_render_jobs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
  END IF;
END $$;
