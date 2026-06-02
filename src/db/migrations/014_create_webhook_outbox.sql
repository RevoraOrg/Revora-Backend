-- Migration: Create webhook_outbox table
-- Description: Transactional outbox for atomic webhook event capture.
--   Rows are inserted inside the producing DB transaction so a crash between
--   commit and emit cannot drop events.  A dispatcher worker drains pending
--   rows and hands them to WebhookQueue.  The idempotent event_id is stable
--   across retries so receivers can deduplicate via webhookEventOrdering.

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL,
  payload      JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'dispatched', 'failed')),
  attempts     INTEGER     NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Dispatcher polls this index: pending rows whose available_at has passed
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_pending
  ON webhook_outbox (available_at)
  WHERE status = 'pending';

CREATE TRIGGER update_webhook_outbox_updated_at
  BEFORE UPDATE ON webhook_outbox
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
