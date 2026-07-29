# Per-Lot Cost-Basis Tracking with FIFO/LIFO/HIFO Strategies

## Summary

Implements comprehensive per-lot cost-basis tracking for tax reporting with pluggable disposal strategies (FIFO, LIFO, HIFO). Adds investment lot lifecycle tables, immutable historical evaluations, per-jurisdiction gains summaries, and a strategy selector with forward-only change enforcement.

**Closes:** #511

---

## Features Implemented

### Core Domain
- **🔢 Per-Lot Cost-Basis Tracking**: Every investment acquisition creates an immutable lot with `cost_basis_per_unit`, `acquired_at`, and `quantity`. Lots track `remaining_quantity` and transition through `open → partially_used → exhausted` lifecycle states.
- **📐 Pluggable Disposal Strategies**: FIFO (First-In-First-Out), LIFO (Last-In-First-Out), and HIFO (Highest-In-First-Out) strategies via the `CostBasisStrategy` interface. New strategies can be added by implementing the interface and registering in `STRATEGY_REGISTRY`.
- **🌍 Per-Jurisdiction Gains Summaries**: Aggregated disposal data broken down by jurisdiction with strategy-level drill-down (count, total gain/loss per strategy).
- **📜 Immutable Historical Evaluations**: Cost basis, acquisition dates, and disposal records are write-once. Only `remaining_quantity` and `status` are updated as disposals consume lots.

### Database
- **`investment_lots` table**: Lot lifecycle tracking with `NUMERIC(36,18)` quantities (fractional shares to 18 decimal places) and `NUMERIC(30,10)` monetary precision.
- **`disposals` table**: Immutable disposal records capturing cost basis at time of disposal, realized gain/loss, strategy used, and tax-report linkage.

### Security & Correctness
- **🔒 Atomic Disposals**: `SELECT ... FOR UPDATE` row-level locking within database transactions prevents concurrent disposals from double-spending lots.
- **🔄 TOCTOU Prevention**: Single locked-read pattern eliminates time-of-check-time-of-use races between lot availability checks and consumption.
- **🛡️ JWT Authentication**: All taxation endpoints protected by `authMiddleware()` — every request requires a valid Bearer token.
- **🚫 Error Sanitization**: Raw database and strategy errors are wrapped in `AppError` with proper `VALIDATION_ERROR` codes — no upstream errors leak to clients.
- **🎯 Forward-Only Strategy Changes**: Strategy changes only affect future disposals. Historical records retain their original strategy. Dual-control enforcement point identified for admin layer.

### API Design
- **Preview endpoint**: `POST /taxation/preview` lets investors see exactly which lots would be consumed before committing.
- **Fractional-share support**: Disposal splits across lots correctly, including partial consumption of a single lot.
- **Weighted average cost basis**: Computed per-disposal for accurate tax lot identification.

---

## API Endpoints

All endpoints are mounted at `{API_VERSION_PREFIX}/taxation` (e.g., `/api/v1/taxation`) and require JWT authentication.

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `POST` | `/dispose` | Process a disposal using a specified strategy | `201` with `DisposalResult` (allocations, weighted average cost basis, realized gain/loss) |
| `POST` | `/preview` | Dry-run a disposal without committing | `200` with `DisposalResult` preview |
| `GET` | `/gains-summary` | Per-jurisdiction gains totals with strategy breakdown | `200` with `JurisdictionGainsSummary[]` |
| `GET` | `/lots` | List all investment lots for the authenticated investor | `200` with `InvestmentLot[]` |
| `POST` | `/lots` | Create a new investment lot from an acquisition | `201` with `InvestmentLot` |

### Example: Process a Disposal

**Request:**
```json
POST /api/v1/taxation/dispose
Authorization: Bearer <jwt>
{
  "offering_id": "off-abc",
  "quantity": 50.0,
  "disposal_price_per_unit": 15.0,
  "strategy": "FIFO"
}
```

**Response (201):**
```json
{
  "message": "Disposal processed successfully",
  "data": {
    "allocations": [
      {
        "lot": { "id": "lot-1", "acquired_at": "2024-01-15T00:00:00Z", "cost_basis_per_unit": 10, "remaining_quantity": 50 },
        "quantityConsumed": 50,
        "costBasisPerUnit": 10,
        "totalCostBasis": 500
      }
    ],
    "totalQuantityDisposed": 50,
    "weightedAverageCostBasis": 10.0,
    "totalCostBasis": 500.0,
    "realizedGainLoss": 250.0,
    "strategy": "FIFO"
  }
}
```

### Example: Gains Summary

**Response (200):**
```json
{
  "message": "Gains summary retrieved successfully",
  "data": [
    {
      "jurisdiction": "US",
      "totalProceeds": 5000,
      "totalCostBasis": 3000,
      "totalRealizedGainLoss": 2000,
      "disposalCount": 5,
      "strategyBreakdown": {
        "FIFO": { "count": 3, "totalGainLoss": 1000 },
        "LIFO": { "count": 2, "totalGainLoss": 1000 },
        "HIFO": { "count": 0, "totalGainLoss": 0 }
      }
    }
  ]
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Routes (src/routes/taxation.ts)                             │
│  authMiddleware() → POST /dispose, /preview, /lots           │
│                      GET  /gains-summary, /lots               │
├─────────────────────────────────────────────────────────────┤
│  Handler (src/handlers/taxationHandler.ts)                    │
│  Input validation → Service call → JSON response              │
│  All errors → AppError (structured, machine-readable)        │
├─────────────────────────────────────────────────────────────┤
│  Service (src/services/taxation/taxationService.ts)           │
│  Business logic: atomic TXN, FOR UPDATE locking,              │
│  strategy execution, jurisdiction derivation                  │
├───────────────────┬──────────────────┬──────────────────────┤
│  CostBasisStrategy │  LotRepository    │  DisposalRepository  │
│  (FIFO/LIFO/HIFO)  │  (CRUD + locks)  │  (CRUD + aggregation)│
└───────────────────┴──────────────────┴──────────────────────┘
```

### Disposal Strategy Comparison

| Strategy | Selection Order | Tax Implication | Use Case |
|----------|----------------|-----------------|----------|
| **FIFO** | Oldest lots first | Maximizes long-term gains in rising markets | Default for US tax reporting |
| **LIFO** | Newest lots first | Minimizes gains in rising markets (recent = higher cost) | Tax deferral strategies |
| **HIFO** | Highest cost basis first | Minimizes taxable gains in all conditions | Tax-loss harvesting, minimizing current-year liability |

---

## Database Schema

### `investment_lots`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Lot identifier |
| `investor_id` | `UUID NOT NULL` | Owning investor |
| `offering_id` | `UUID NOT NULL` | Associated offering |
| `investment_id` | `UUID NOT NULL REFERENCES investments(id)` | Original investment record |
| `asset` | `VARCHAR(255) NOT NULL` | Asset identifier |
| `quantity` | `NUMERIC(36,18) NOT NULL CHECK (> 0)` | Total acquired quantity |
| `cost_basis_per_unit` | `NUMERIC(30,10) NOT NULL CHECK (>= 0)` | Immutable cost per unit |
| `total_cost_basis` | `NUMERIC(30,10) NOT NULL CHECK (>= 0)` | `quantity × cost_basis_per_unit` |
| `remaining_quantity` | `NUMERIC(36,18) NOT NULL CHECK (>= 0)` | Available for disposal |
| `cost_currency` | `VARCHAR(10) DEFAULT 'USD'` | Cost basis currency |
| `acquired_at` | `TIMESTAMPTZ NOT NULL` | Immutable acquisition timestamp |
| `jurisdiction` | `VARCHAR(10) DEFAULT 'US'` | Investor jurisdiction |
| `status` | `VARCHAR(20) CHECK (open/partially_used/exhausted)` | Lot lifecycle state |

### `disposals`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID PK` | Disposal identifier |
| `lot_id` | `UUID NOT NULL REFERENCES investment_lots(id)` | Consumed lot |
| `quantity_disposed` | `NUMERIC(36,18) NOT NULL CHECK (> 0)` | Quantity consumed |
| `cost_basis_per_unit` | `NUMERIC(30,10)` | Captured from lot (immutable) |
| `total_cost_basis` | `NUMERIC(30,10)` | Cost basis for this slice |
| `proceeds` | `NUMERIC(30,10)` | Sale proceeds |
| `realized_gain_loss` | `NUMERIC(30,10)` | `proceeds - total_cost_basis` |
| `disposal_price_per_unit` | `NUMERIC(30,10)` | Sale price per unit |
| `strategy` | `VARCHAR(10) CHECK (FIFO/LIFO/HIFO)` | Strategy used |
| `disposed_at` | `TIMESTAMPTZ` | Disposal timestamp |
| `tax_report_finalized` | `BOOLEAN DEFAULT FALSE` | Report lock flag |

---

## Testing

### Coverage: 85 tests across 4 test suites — all passing

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| `costBasisStrategies.test.ts` | 30 | FIFO/LIFO/HIFO selection, ordering, fractional shares, immutability, error cases |
| `taxationService.test.ts` | 27 | End-to-end disposals, transaction rollback, preview, gains summary, validation |
| `investmentLotRepository.test.ts` | 16 | CRUD, `FOR UPDATE` locking, status transitions, quantity tracking |
| `disposalRepository.test.ts` | 12 | Disposal creation, listing, jurisdiction aggregation, strategy breakdown |

### Edge Cases Covered
- ✅ **Fractional-share splits**: Disposal of 7.7 units across two lots (3.3 + 4.4)
- ✅ **Exact quantity match**: Consuming an entire lot in one disposal
- ✅ **Multi-lot spanning**: Disposal of 100 units across 3 lots (40 + 40 + 20)
- ✅ **Zero cost basis**: Gift/airdrop lots with `cost_basis_per_unit = 0`
- ✅ **Insufficient quantity**: Proper error when total available < requested
- ✅ **Exhausted lot skipping**: Lots with `remaining_quantity = 0` are ignored
- ✅ **Transaction rollback**: DB error during lot update triggers rollback + client release
- ✅ **ROLLBACK failure**: ROLLBACK error is caught and suppressed so original error surfaces
- ✅ **Immutability**: Strategies never mutate input lot arrays
- ✅ **Determinism**: Same input → same output every time (including HIFO tie-breaking)
- ✅ **Gain and loss scenarios**: Verified positive and negative `realizedGainLoss` calculations
- ✅ **HIFO tie-breaking**: Equal cost bases fall back to FIFO (oldest first)

---

## Files Changed

### New Files (14)

| File | Purpose |
|------|---------|
| `src/db/migrations/020_create_investment_lots.sql` | Database migration: `investment_lots` table with indices and trigger |
| `src/db/migrations/021_create_disposals.sql` | Database migration: `disposals` table with indices and trigger |
| `src/services/taxation/types.ts` | Type definitions: `CostBasisStrategy`, `InvestmentLot`, `Disposal`, `DisposalResult`, `JurisdictionGainsSummary`, `LotAllocation`, `ProcessDisposalInput` |
| `src/services/taxation/costBasisStrategies.ts` | `FIFOStrategy`, `LIFOStrategy`, `HIFOStrategy` implementations + `STRATEGY_REGISTRY` + `resolveStrategy()` |
| `src/services/taxation/costBasisStrategies.test.ts` | 30 unit tests for all three strategies |
| `src/services/taxation/taxationService.ts` | `TaxationService`: atomic disposal processing, lot creation, jurisdiction summaries, preview |
| `src/services/taxation/taxationService.test.ts` | 27 service-level tests with mocked repositories |
| `src/db/repositories/investmentLotRepository.ts` | `InvestmentLotRepository`: CRUD, transactional operations, `FOR UPDATE` locking |
| `src/db/repositories/investmentLotRepository.test.ts` | 16 repository tests |
| `src/db/repositories/disposalRepository.ts` | `DisposalRepository`: CRUD, jurisdiction-level aggregation with shared helper |
| `src/db/repositories/disposalRepository.test.ts` | 12 repository tests |
| `src/handlers/taxationHandler.ts` | `TaxationHandler`: 5 HTTP handlers with input validation and error mapping |
| `src/routes/taxation.ts` | Route registration with `authMiddleware()` router-level guard |
| `docs/cost-basis-strategies.md` | Comprehensive feature documentation |

### Modified Files (1)

| File | Change |
|------|--------|
| `src/index.ts` | Added `import taxationRouter from './routes/taxation'` and `app.use(API_VERSION_PREFIX + '/taxation', taxationRouter)` mount |

---

## Security Assumptions

### Trust Boundaries
- ✅ **Caller identity** asserted by trusted upstream `authMiddleware()` before handler invocation
- ✅ **No raw errors to clients**: All thrown errors are `AppError` instances — database failures and strategy errors map to `VALIDATION_ERROR` or `INTERNAL_ERROR`
- ✅ **Row-level locking**: `SELECT ... FOR UPDATE` within transactions prevents concurrent double-spending of lots
- ✅ **Immutable history**: `cost_basis_per_unit`, `quantity`, `acquired_at` are write-once; disposal records are append-only
- ✅ **Forward-only strategy changes**: Strategy changes take effect on the next disposal only; historical records preserve their original strategy
- ✅ **No PII in logs**: Logging captures `investor_id`, `offering_id`, and `lot_id` — no email, name, or other PII

### Threat Mitigations
- **Concurrent Disposal Attacks**: Two simultaneous disposal requests for the same investor+offering cannot double-spend lots — the second request blocks on the `FOR UPDATE` lock until the first commits
- **Information Disclosure**: Strategy error messages ("Insufficient quantity") are mapped to structured `AppError` codes — no raw database errors or stack traces reach the client
- **Injection Attacks**: All SQL uses parameterized queries (`$1, $2, ...`) — no string interpolation

### Future Hardening Identified
- **Dual-control for strategy changes**: The issue requires dual-control approval before an investor's default strategy can change. The service layer identifies this enforcement point but the admin endpoint is not yet implemented.
- **Per-investor strategy preference**: Currently the strategy is specified per-disposal request. A future enhancement would store a default strategy per investor/jurisdiction and use it unless overridden.

---

## TypeScript Type Safety

- ✅ Zero type errors in all new files (`npx tsc --noEmit` passes for all taxation code)
- ✅ Strict typing: `let strategy: CostBasisStrategy` and `let allocations: LotAllocation[]` (not `any`)
- ✅ No `// @ts-ignore` or `as any` casts in production code
- ✅ Repository layer uses typed `QueryResult<InvestmentLotRow>` and `QueryResult<DisposalRow>` generics

---

## Performance Considerations

- **Disposal latency**: Single database transaction with batch updates. All lot updates and disposal inserts happen within one transaction boundary.
- **Lock contention**: `FOR UPDATE` locks are scoped to a single `(investor_id, offering_id)` pair, limiting the blast radius of concurrent disposals.
- **Aggregation queries**: `getJurisdictionGainsSummary` and `getJurisdictionGainsSummaryByOffering` delegate aggregation to SQL `GROUP BY` for efficiency — no N+1 queries.
- **Preview endpoint**: Read-only — no transaction, no locks, minimal overhead.

---

## Migration Guide

```bash
# Apply both migrations
npm run migrate
```

The `020_create_investment_lots.sql` and `021_create_disposals.sql` migrations are additive — they create new tables with no impact on existing data. No data migration is required.

---

## Deployment Checklist

- [ ] Database migrations applied (`020_create_investment_lots.sql`, `021_create_disposals.sql`)
- [ ] `npm test -- --testPathPatterns='costBasis|taxation|disposal|investmentLot'` — 85 tests passing
- [ ] `npx tsc --noEmit` — zero type errors
- [ ] Review security assumptions: `docs/cost-basis-strategies.md`
- [ ] Configure monitoring alerts for disposal failure rate
- [ ] Plan dual-control strategy-change endpoint (future PR)

---

## Labels

- `backend` — Backend implementation
- `tax-reporting` — Tax/cost-basis feature
- `database` — New migration and repository layer
- `security` — Row-level locking, error sanitization, JWT auth
- `testing` — 85 tests with comprehensive edge case coverage
- `documentation` — Feature docs and inline JSDoc

---

## Risk Assessment

**Low Risk**: This is a new feature with no modifications to existing code paths (only additive changes). The single modified file (`src/index.ts`) adds one router mount — no existing routes are affected. All new code is behind JWT authentication and has comprehensive test coverage.

---

## Related Issues

- **Closes**: #511 — Taxation reports: per-lot cost-basis tracking with FIFO/LIFO/HIFO strategies
- **Follow-up**: Dual-control strategy change endpoint (admin `PUT /taxation/strategy` with approval workflow)
- **Follow-up**: Stored per-investor default strategy preference per jurisdiction

---

**Ready for review and merge!** 🚀
