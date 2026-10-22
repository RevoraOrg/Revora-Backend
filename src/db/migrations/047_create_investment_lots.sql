-- Migration: Create investment_lots table
-- Description: Adds database table for per-lot cost-basis tracking of investment acquisitions.
-- Each lot represents a discrete purchase/acquisition of an asset with immutable cost basis.
-- Lots are consumed by disposals using pluggable strategies (FIFO, LIFO, HIFO).

CREATE TABLE IF NOT EXISTS investment_lots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id UUID NOT NULL,
    offering_id UUID NOT NULL,
    investment_id UUID NOT NULL REFERENCES investments(id) ON DELETE RESTRICT,
    asset VARCHAR(255) NOT NULL,
    -- Quantity acquired in this lot (supports fractional shares up to 18 decimal places)
    quantity NUMERIC(36, 18) NOT NULL CHECK (quantity > 0),
    -- Cost basis per unit at acquisition time (immutable once set)
    cost_basis_per_unit NUMERIC(30, 10) NOT NULL CHECK (cost_basis_per_unit >= 0),
    -- Total cost basis for the lot (quantity * cost_basis_per_unit)
    total_cost_basis NUMERIC(30, 10) NOT NULL CHECK (total_cost_basis >= 0),
    -- Remaining quantity available for disposal (starts at quantity, decreases with disposals)
    remaining_quantity NUMERIC(36, 18) NOT NULL CHECK (remaining_quantity >= 0),
    -- Currency of the cost basis (e.g., USD, USDC)
    cost_currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    -- Acquisition date (immutable, used for FIFO/LIFO ordering)
    acquired_at TIMESTAMPTZ NOT NULL,
    -- Jurisdiction of the investor for tax reporting
    jurisdiction VARCHAR(10) NOT NULL DEFAULT 'US',
    -- Lot status: open (available for disposal), partially_used, exhausted
    status VARCHAR(20) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'partially_used', 'exhausted')),
    -- Standard timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_investment_lots_investor_id ON investment_lots (investor_id);
CREATE INDEX IF NOT EXISTS idx_investment_lots_offering_id ON investment_lots (offering_id);
CREATE INDEX IF NOT EXISTS idx_investment_lots_investment_id ON investment_lots (investment_id);
CREATE INDEX IF NOT EXISTS idx_investment_lots_acquired_at ON investment_lots (acquired_at);
CREATE INDEX IF NOT EXISTS idx_investment_lots_status ON investment_lots (status);
CREATE INDEX IF NOT EXISTS idx_investment_lots_investor_offering ON investment_lots (investor_id, offering_id);
CREATE INDEX IF NOT EXISTS idx_investment_lots_jurisdiction ON investment_lots (jurisdiction);

-- Trigger for updated_at (reuses function from 002_create_investments.sql)
DROP TRIGGER IF EXISTS update_investment_lots_updated_at ON investment_lots;
CREATE TRIGGER update_investment_lots_updated_at
    BEFORE UPDATE ON investment_lots
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
