-- Migration: Create offerings table
-- Description: Adds database table for revenue-share offerings

CREATE TABLE IF NOT EXISTS offerings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_asset_id VARCHAR(255) NOT NULL,
    revenue_share_bps INTEGER NOT NULL CHECK (revenue_share_bps >= 0 AND revenue_share_bps <= 10000),
    status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_offerings_issuer_user_id ON offerings (issuer_user_id);
CREATE INDEX IF NOT EXISTS idx_offerings_status ON offerings (status);

-- Trigger for updated_at (reuses update_updated_at_column from previous migrations if exists, otherwise we create it)
-- To be safe and since triggers are per-table:
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
        CREATE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
        END;
        $func$ language 'plpgsql';
    END IF;
END $$;

DROP TRIGGER IF EXISTS update_offerings_updated_at ON offerings;
CREATE TRIGGER update_offerings_updated_at
    BEFORE UPDATE ON offerings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
