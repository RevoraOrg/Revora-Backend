-- Migration: Create webhook_deliveries table
-- Description: Persists webhook delivery attempts for durable retry

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id   UUID        NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  payload       JSONB       NOT NULL,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL DEFAULT 'pending',
  next_retry_at TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next_retry
  ON webhook_deliveries (status, next_retry_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_id
  ON webhook_deliveries (endpoint_id);

CREATE TRIGGER update_webhook_deliveries_updated_at
    BEFORE UPDATE ON webhook_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
