-- Migration: Create wash_sale_adjustments table
-- Description: Tracks cost-basis adjustments for wash-sale disallowed losses.
-- Adjustments are idempotent per (investor_id, offering_id, disposed_at).
-- Each adjustment emits an audit event via audit_logs with prev_hash -> row_hash chain.

CREATE TABLE IF NOT EXISTS wash_sale_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investor_id UUID NOT NULL,
    offering_id UUID NOT NULL,
    lot_id UUID NOT NULL REFERENCES investment_lots(id) ON DELETE RESTRICT,
    original_disposal_id UUID,
    adjustment_amount NUMERIC(30, 10) NOT NULL CHECK (adjustment_amount >= 0),
    original_cost_basis_per_unit NUMERIC(30, 10) NOT NULL CHECK (original_cost_basis_per_unit >= 0),
    adjusted_cost_basis_per_unit NUMERIC(30, 10) NOT NULL CHECK (adjusted_cost_basis_per_unit >= 0),
    window_days INTEGER NOT NULL CHECK (window_days BETWEEN 1 AND 365),
    disposed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (investor_id, offering_id, disposed_at)
);

CREATE INDEX IF NOT EXISTS idx_wash_sale_investor_id ON wash_sale_adjustments (investor_id);
CREATE INDEX IF NOT EXISTS idx_wash_sale_offering_id ON wash_sale_adjustments (offering_id);
CREATE INDEX IF NOT EXISTS idx_wash_sale_lot_id ON wash_sale_adjustments (lot_id);
CREATE INDEX IF NOT EXISTS idx_wash_sale_disposed_at ON wash_sale_adjustments (disposed_at);
CREATE INDEX IF NOT EXISTS idx_wash_sale_investor_offering_date ON wash_sale_adjustments (investor_id, offering_id, disposed_at);

CREATE TRIGGER update_wash_sale_adjustments_updated_at
    BEFORE UPDATE ON wash_sale_adjustments
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();