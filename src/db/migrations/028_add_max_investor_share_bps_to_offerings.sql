-- Migration: Add max_investor_share_bps to offerings
-- Description: Persists the per-investor concentration cap synced from on-chain config.
--              NULL means no cap (unlimited). 10000 = 100%, 1000 = 10%, etc.

ALTER TABLE offerings
  ADD COLUMN IF NOT EXISTS max_investor_share_bps INTEGER
    CHECK (max_investor_share_bps IS NULL OR (max_investor_share_bps >= 0 AND max_investor_share_bps <= 10000));
