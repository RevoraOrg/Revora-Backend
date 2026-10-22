-- Migration: Create revenue_reports table
-- Description: Adds database table for revenue reports submitted by startup issuers
--
-- UP Migration (applied automatically by migrate.js)
-- Creates the revenue_reports table with all necessary columns, indexes, and constraints
--
-- DOWN Migration (manual rollback if needed):
-- DROP TRIGGER IF EXISTS update_revenue_reports_updated_at ON revenue_reports;
-- DROP INDEX IF EXISTS idx_revenue_reports_unique_period;
-- DROP INDEX IF EXISTS idx_revenue_reports_period;
-- DROP INDEX IF EXISTS idx_revenue_reports_status;
-- DROP INDEX IF EXISTS idx_revenue_reports_issuer_id;
-- DROP INDEX IF EXISTS idx_revenue_reports_offering_id;
-- DROP TABLE IF EXISTS revenue_reports;

CREATE TABLE IF NOT EXISTS revenue_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Core identifiers
    offering_id UUID NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
    issuer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    
    -- Period identification (supports both string-based period_id and date-based periods)
    period_id VARCHAR(255), -- Optional identifier for the reporting period (e.g., "2024-Q1")
    period_start TIMESTAMPTZ, -- Start date of the revenue period
    period_end TIMESTAMPTZ, -- End date of the revenue period
    
    -- Revenue data
    amount NUMERIC(30, 10) NOT NULL CHECK (amount > 0), -- Revenue amount for this period
    total_revenue NUMERIC(30, 10), -- Optional: total cumulative revenue (if tracked)
    
    -- Workflow and audit fields
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- When the report was submitted
    reported_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT, -- Who submitted the report
    
    -- Standard timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Ensure period dates are valid when provided
    CONSTRAINT valid_period_dates CHECK (
        (period_start IS NULL AND period_end IS NULL) OR 
        (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start)
    )
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_revenue_reports_offering_id ON revenue_reports (offering_id);
CREATE INDEX IF NOT EXISTS idx_revenue_reports_issuer_id ON revenue_reports (issuer_id);
CREATE INDEX IF NOT EXISTS idx_revenue_reports_status ON revenue_reports (status);
CREATE INDEX IF NOT EXISTS idx_revenue_reports_period ON revenue_reports (offering_id, period_start, period_end);

-- Composite unique constraint to prevent duplicate reports for the same offering and period
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_reports_unique_period 
    ON revenue_reports (offering_id, period_start, period_end) 
    WHERE period_start IS NOT NULL AND period_end IS NOT NULL;

-- Trigger for updated_at (reuses function from previous migrations)
DROP TRIGGER IF EXISTS update_revenue_reports_updated_at ON revenue_reports;
CREATE TRIGGER update_revenue_reports_updated_at
    BEFORE UPDATE ON revenue_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
