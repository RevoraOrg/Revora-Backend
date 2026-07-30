# Wash-Sale Detection for Tax Reports

## Overview

US tax reporting requires adjusting cost basis when a wash sale occurs. This module implements a wash-sale detector with a configurable window that recomputes cost basis and emits an audit event per adjustment.

## How It Works

A wash sale occurs when an investor disposes of a security at a loss and repurchases the same or substantially identical security within a configurable window (default 30 days, configurable between 1-365 days) before or after the disposal.

The disallowed loss is added to the cost basis of the repurchased lots, proportionally distributed across all repurchase lots found within the window.

## Key Components

### WashSaleDetector (`src/services/taxation/washSaleDetector.ts`)

Main detection logic. Usage:

```typescript
const detector = createWashSaleDetector(lotRepo, adjustmentRepo, auditLogRepo, db);
const result = await detector.detect({
  investor_id: 'inv-1',
  offering_id: 'off-1',
  disposed_at: new Date('2024-06-15'),
  disposal_realized_gain_loss: -500,
  disposal_quantity: 50,
  disposal_cost_basis_per_unit: 10,
  window_days: 30, // optional, defaults to 30
});
```

### WashSaleAdjustmentRepository (`src/db/repositories/washSaleAdjustmentRepository.ts`)

Persists wash-sale cost-basis adjustments. Each adjustment is uniquely identified by `(investor_id, offering_id, disposed_at)` ensuring idempotency.

### Database Table (`wash_sale_adjustments`)

Migration `024_create_wash_sale_adjustments.sql` creates the table with:
- Unique constraint on `(investor_id, offering_id, disposed_at)` for idempotency
- Foreign key to `investment_lots(id)` with `ON DELETE RESTRICT`
- Indexes on `investor_id`, `offering_id`, `lot_id`, and `disposed_at`
- `CHECK` constraints on `adjustment_amount >= 0`, `window_days BETWEEN 1 AND 365`

## API Endpoints

- `POST /api/v1/taxation/wash-sale-detection` — Runs wash-sale detection for a disposal

## Security Assumptions

- Caller identity is asserted by trusted upstream auth middleware (`investor_id` from JWT).
- Idempotency is enforced at the repository layer via unique constraint on `(investor_id, offering_id, disposed_at)`.
- Audit chain integrity is maintained through the existing `audit_logs` table with `prev_hash → row_hash` linking.
- The wash-sale window is bounded (1-365 days) to prevent abuse.
- Cost basis adjustments are additive (disallowed loss added to repurchase lot cost basis), never reducing basis below zero.
- All monetary values use `NUMERIC(30,10)` precision matching existing taxation column types.

## Idempotency

Adjustments are idempotent per `(investor, offering, disposed_at)`. Re-running detection for the same key returns the existing adjustment without creating duplicates. This is enforced by:
1. A `UNIQUE` constraint on `(investor_id, offering_id, disposed_at)` in the database.
2. A pre-insert lookup via `findByInvestorOfferingDate` that checks for existing rows within the transaction.

## Edge Cases Handled

1. **Gain on disposal** — No wash sale triggered (no adjustment needed).
2. **No repurchase within window** — No adjustment created.
3. **Multiple repurchase lots** — Disallowed loss is proportionally allocated across all lots by remaining quantity.
4. **Same-day repurchase across two accounts** — Each account's adjustment is independent (idempotency key includes `investor_id`).
5. **Repeated detection for same key** — Returns existing adjustment without duplication.
6. **Repository errors** — Transaction is rolled back and error propagated.