# Per-Lot Cost-Basis Tracking with FIFO/LIFO/HIFO Strategies

## Overview

The tax cost-basis tracking system provides per-lot accounting for investment acquisitions and disposals with pluggable disposal strategies (FIFO, LIFO, HIFO). Each investment lot represents a discrete acquisition with an immutable cost basis, acquired_at timestamp, and quantity. When units are disposed (sold/transferred), the configured strategy determines which lots to consume and in what order.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TaxationHandler                       │
│  (HTTP: POST /dispose, POST /preview, GET /summary)     │
├─────────────────────────────────────────────────────────┤
│                    TaxationService                       │
│  (Business logic, transaction orchestration)             │
├──────────────────┬──────────────────┬───────────────────┤
│  CostBasisStrategy Interface       │  Repositories      │
│  ├── FIFOStrategy                  │  ├── LotRepo       │
│  ├── LIFOStrategy                  │  └── DisposalRepo  │
│  └── HIFOStrategy                  │                    │
└──────────────────┴──────────────────┴───────────────────┘
```

## Database Schema

### `investment_lots`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Lot identifier |
| investor_id | UUID FK | Investor who owns this lot |
| offering_id | UUID FK | Offering associated with this lot |
| investment_id | UUID FK | Original investment record |
| asset | VARCHAR(255) | Asset identifier (e.g., USDC) |
| quantity | NUMERIC(36,18) | Total quantity acquired |
| cost_basis_per_unit | NUMERIC(30,10) | Cost per unit (immutable) |
| total_cost_basis | NUMERIC(30,10) | quantity × cost_basis_per_unit |
| remaining_quantity | NUMERIC(36,18) | Quantity still available |
| cost_currency | VARCHAR(10) | Currency (default: USD) |
| acquired_at | TIMESTAMPTZ | Acquisition timestamp (immutable) |
| jurisdiction | VARCHAR(10) | Investor jurisdiction |
| status | VARCHAR(20) | open / partially_used / exhausted |

### `disposals`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID PK | Disposal identifier |
| investor_id | UUID FK | Investor who disposed |
| offering_id | UUID FK | Offering |
| lot_id | UUID FK | Consumed lot |
| quantity_disposed | NUMERIC(36,18) | Quantity consumed |
| cost_basis_per_unit | NUMERIC(30,10) | Captured from lot (immutable) |
| total_cost_basis | NUMERIC(30,10) | Cost basis for this disposal |
| proceeds | NUMERIC(30,10) | Sale proceeds |
| realized_gain_loss | NUMERIC(30,10) | proceeds - total_cost_basis |
| disposal_price_per_unit | NUMERIC(30,10) | Sale price per unit |
| strategy | VARCHAR(10) | FIFO / LIFO / HIFO |
| disposed_at | TIMESTAMPTZ | Disposal timestamp |
| tax_report_finalized | BOOLEAN | Whether included in finalized report |

## Disposal Strategies

### FIFO (First-In-First-Out)
- **Default strategy** for US tax reporting
- Consumes oldest lots first (by `acquired_at` ascending)
- Maximizes long-term capital gains treatment in rising markets

### LIFO (Last-In-First-Out)
- Consumes newest lots first (by `acquired_at` descending)
- Minimizes taxable gains in rising markets by selling higher-cost-basis lots first
- Not permitted in all jurisdictions

### HIFO (Highest-In-First-Out)
- Consumes highest cost-basis lots first
- **Minimizes taxable gains** in all market conditions
- Tie-breaking: when cost bases are equal, falls back to FIFO (oldest first)

## API Endpoints

### POST /taxation/dispose
Process a disposal using the specified strategy.

```json
{
  "offering_id": "off-abc",
  "quantity": 50.0,
  "disposal_price_per_unit": 15.0,
  "strategy": "FIFO"
}
```

Response (201):
```json
{
  "message": "Disposal processed successfully",
  "data": {
    "allocations": [...],
    "totalQuantityDisposed": 50.0,
    "weightedAverageCostBasis": 10.0,
    "totalCostBasis": 500.0,
    "realizedGainLoss": 250.0,
    "strategy": "FIFO"
  }
}
```

### POST /taxation/preview
Preview a disposal without committing.

### GET /taxation/gains-summary
Get per-jurisdiction gains totals with strategy breakdowns.

### GET /taxation/lots
List investment lots for the authenticated investor.

### POST /taxation/lots
Create a new investment lot.

## Security Assumptions

1. **Immutable historical evaluations**: Cost basis and lot metadata are never modified after creation. Only `remaining_quantity` and `status` change during disposal.
2. **Atomic transactions**: Disposals use `FOR UPDATE` row-level locking and database transactions to prevent double-spending of lots.
3. **Forward-only strategy changes**: When an investor changes their disposal strategy, it only affects future disposals. Historical disposals retain their original strategy.
4. **Dual-control**: Strategy changes require dual-control authorization (enforced at the admin layer).
5. **No raw errors leak to clients**: All errors are mapped to structured `AppError` instances.

## Testing

```bash
# Run all taxation-related tests
npm test -- --testPathPattern=taxation

# Run specific strategy tests
npm test -- --testPathPattern=costBasisStrategies

# Run service tests
npm test -- --testPathPattern=taxationService
```

## Migration

```bash
# Apply migrations
npm run migrate
```
