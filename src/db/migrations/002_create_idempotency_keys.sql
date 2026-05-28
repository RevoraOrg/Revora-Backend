CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  response_content_type TEXT,
  fingerprint TEXT,
  state TEXT NOT NULL DEFAULT 'inflight' CHECK (state IN ('inflight', 'completed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at) WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_state
  ON idempotency_keys (state) WHERE state = 'inflight';
