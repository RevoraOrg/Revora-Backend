-- Migration: Create webhook_endpoints table
-- Description: Stores webhook endpoint registrations per owner with event subscriptions

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID        NOT NULL,
  url        TEXT        NOT NULL,
  secret     TEXT        NOT NULL,
  events     TEXT[]      NOT NULL DEFAULT '{}',
  active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_owner_id
  ON webhook_endpoints (owner_id);

-- Partial index for active-only queries
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active
  ON webhook_endpoints (active)
  WHERE active = TRUE;

-- GIN index to efficiently query endpoints subscribed to a given event
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_events
  ON webhook_endpoints USING GIN (events);

-- Reuse update_updated_at_column() if already defined, otherwise create it
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE 'plpgsql';

CREATE TRIGGER update_webhook_endpoints_updated_at
    BEFORE UPDATE ON webhook_endpoints
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
