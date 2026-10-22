CREATE TABLE IF NOT EXISTS audit_witness_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    root_hash TEXT NOT NULL,
    witness_type TEXT NOT NULL,
    receipt_data JSONB NOT NULL,
    published_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_witness_receipts_published_at ON audit_witness_receipts(published_at);
CREATE INDEX IF NOT EXISTS idx_audit_witness_receipts_root_hash ON audit_witness_receipts(root_hash);
