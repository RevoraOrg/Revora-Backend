-- Migration: add absolute refresh-token family lifetime to sessions
--
-- Why:
--   Refresh tokens are rotated on every use, and each rotation previously reset
--   the sliding 7-day expiry with no upper bound. That allowed a refresh token
--   family to live forever as long as it was used at least once every 7 days.
--
--   `family_expires_at` is the immutable, absolute deadline for a token family.
--   It is set once when the family is created (at login) and inherited verbatim
--   by every child session created during rotation. Once the deadline passes,
--   RefreshService refuses to rotate the family any further.
--
-- Backfill:
--   Existing sessions are anchored to the creation time of their family root so
--   no pre-existing family is granted an unbounded lifetime. Because the graph
--   can be several levels deep, we walk it recursively from each root.
--
-- Safety:
--   - Idempotent (IF NOT EXISTS).
--   - Additive only; no data is dropped or rewritten destructively.
--   - The backfill only fills rows where the column is still NULL, so re-running
--     never overwrites an already-established deadline.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS family_expires_at TIMESTAMP WITH TIME ZONE NULL;

-- Backfill: descendants inherit their family root's created_at + 30 days.
WITH RECURSIVE family_members AS (
  -- Roots: sessions that have no parent (family origin, created at login).
  SELECT
    s.id,
    s.id AS root_id,
    s.created_at AS root_created_at
  FROM sessions s
  WHERE s.parent_id IS NULL

  UNION ALL

  -- Children inherit the root of their parent.
  SELECT
    c.id,
    fm.root_id,
    fm.root_created_at
  FROM sessions c
  JOIN family_members fm ON c.parent_id = fm.id
)
UPDATE sessions s
SET family_expires_at = fm.root_created_at + INTERVAL '30 days'
FROM family_members fm
WHERE s.id = fm.id
  AND s.family_expires_at IS NULL;

-- Index to support family-scoped lookups / revocation sweeps.
CREATE INDEX IF NOT EXISTS idx_sessions_family_expires_at
  ON sessions(family_expires_at);

-- ─── Account status ────────────────────────────────────────────────────────
--
-- RefreshService reloads the user on every rotation and refuses to re-issue
-- tokens for a disabled account. A SCIM de-provision can set `status` to
-- 'suspended' (or 'disabled') without deleting the row, which lets the
-- refresh path fail closed on the very next rotation.
--
-- The column is additive with a safe default so existing rows are treated as
-- active until an administrator changes them.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('active', 'suspended', 'disabled', 'deactivated'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
