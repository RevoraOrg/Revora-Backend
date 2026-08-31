-- Migration: Create disposals table
-- Description: Records each disposal (sale/transfer) of investment lots with immutable
-- cost-basis calculations. Each disposal consumes one or more lots based on the
-- selected strategy (FIFO, LIFO, HIFO). Historical evaluations are immutable.

CREATE TABLE IF NOT EXISTS disposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id UUID NOT NULL,
    offering_id UUID NOT NULL,
    -- The lot that was consumed for this disposal
    lot_id UUID NOT NULL REFERENCES investment_lots(id) ON DELETE RESTRICT,
    -- Quantity disposed from this lot
    quantity_disposed NUMERIC(36, 18) NOT NULL CHECK (quantity_disposed > 0),
    -- Cost basis per unit at the time of disposal (captured from the lot, immutable)
    cost_basis_per_unit NUMERIC(30, 10) NOT NULL CHECK (cost_basis_per_unit >= 0),
    -- Total cost basis for this disposal (quantity_disposed * cost_basis_per_unit)
    total_cost_basis NUMERIC(30, 10) NOT NULL CHECK (total_cost_basis >= 0),
    -- Proceeds from the disposal (sale price)
    proceeds NUMERIC(30, 10) NOT NULL DEFAULT 0 CHECK (proceeds >= 0),
    -- Realized gain/loss (proceeds - total_cost_basis)
    realized_gain_loss NUMERIC(30, 10) NOT NULL DEFAULT 0,
    -- Disposal price per unit at time of sale
    disposal_price_per_unit NUMERIC(30, 10) NOT NULL CHECK (disposal_price_per_unit >= 0),
    -- Strategy used for this disposal (FIFO, LIFO, HIFO)
    strategy VARCHAR(10) NOT NULL CHECK (strategy IN ('FIFO', 'LIFO', 'HIFO')),
    -- Currency of the proceeds
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    -- Jurisdiction of the investor at time of disposal
    jurisdiction VARCHAR(10) NOT NULL DEFAULT 'US',
    -- Disposal date (immutable, used for tax period assignment)
    disposed_at TIMESTAMPTZ NOT NULL,
    -- Whether this disposal has been included in a finalized tax report
    tax_report_finalized BOOLEAN NOT NULL DEFAULT FALSE,
    -- Reference to the tax report that includes this disposal (NULL until finalized)
    tax_report_id UUID,
    -- Standard timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_disposals_investor_id ON disposals (investor_id);
CREATE INDEX IF NOT EXISTS idx_disposals_offering_id ON disposals (offering_id);
CREATE INDEX IF NOT EXISTS idx_disposals_lot_id ON disposals (lot_id);
CREATE INDEX IF NOT EXISTS idx_disposals_disposed_at ON disposals (disposed_at);
CREATE INDEX IF NOT EXISTS idx_disposals_strategy ON disposals (strategy);
CREATE INDEX IF NOT EXISTS idx_disposals_jurisdiction ON disposals (jurisdiction);
CREATE INDEX IF NOT EXISTS idx_disposals_tax_report ON disposals (tax_report_id);
CREATE INDEX IF NOT EXISTS idx_disposals_investor_jurisdiction ON disposals (investor_id, jurisdiction);
CREATE INDEX IF NOT EXISTS idx_disposals_offering_jurisdiction ON disposals (offering_id, jurisdiction, disposed_at);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_disposals_updated_at ON disposals;
CREATE TRIGGER update_disposals_updated_at
    BEFORE UPDATE ON disposals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
