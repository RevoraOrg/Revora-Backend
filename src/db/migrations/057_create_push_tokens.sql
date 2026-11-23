-- Migration: create push_tokens table for device token lifecycle management
-- Handles APNs/FCM device registration tokens with pruning support.
CREATE TABLE IF NOT EXISTS push_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         VARCHAR(128)  NOT NULL,
    token           TEXT          NOT NULL,
    provider        VARCHAR(16)   NOT NULL CHECK (provider IN ('fcm', 'apns')),
    status          VARCHAR(16)   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pruned', 'expired')),
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Prevent duplicate token registrations
    CONSTRAINT uq_push_tokens_token UNIQUE (token)
);

-- Index for fast lookup by user (for sending notifications)
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens (user_id);

-- Partial index for active tokens only (most queries target active tokens)
CREATE INDEX IF NOT EXISTS idx_push_tokens_active ON push_tokens (user_id, provider) WHERE status = 'active';
