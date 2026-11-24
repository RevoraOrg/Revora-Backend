-- Replay-protection nonce store for admin signature verification.
--
-- Records each accepted admin request nonce so a captured, signed admin
-- request cannot be replayed within the freshness window — across replicas
-- (the store is shared via PostgreSQL) and across restarts (the store is
-- persistent). This is the persistent backing store for the
-- PostgresAdminNonceStore used by verifyAdminSignature().
--
-- `(kid, nonce)` is the single-use pair from the signed admin payload
-- (`x-admin-kid` + the signed `nonce`), so both values are authenticated by
-- the Ed25519 signature check before reaching this table. The composite
-- PRIMARY KEY doubles as the unique constraint that makes
-- INSERT ... ON CONFLICT (kid, nonce) DO UPDATE an atomic check-and-add: the
-- first replica to insert wins, concurrent duplicates resolve to the conflict
-- path and are reported as replays.
CREATE TABLE IF NOT EXISTS admin_nonces (
  kid TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (kid, nonce)
);

-- Supports the periodic cleanup job (DELETE ... WHERE expires_at < NOW())
-- and the expiry predicate used at query time.
CREATE INDEX IF NOT EXISTS idx_admin_nonces_expires_at
  ON admin_nonces (expires_at);
