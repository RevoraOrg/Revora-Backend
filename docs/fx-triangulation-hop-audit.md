# Multi-Currency FX Engine: Triangulation via Reference Currency with Hop-Cost Audit

## Overview

Some currency pairs are unavailable directly from rate providers (e.g. EUR/JPY
may not have a direct quote). `FxConversionEngine.triangulate()` routes such
conversions through one or more **reference (via) currencies** — typically USD —
and records a per-hop audit trail so auditors can fully reconstruct the
derivation.

```
  EUR  ──[leg 0]──►  USD  ──[leg 1]──►  JPY
  FxHop { hopIndex:0 }    FxHop { hopIndex:1 }
```

---

## New Types

### `FxHop`

```typescript
interface FxHop {
  from:          string;   // Source currency of this leg
  to:            string;   // Destination currency of this leg
  effectiveRate: Decimal;  // Per-unit rate applied (bid | ask | mid)
  side:          'bid' | 'ask' | 'mid';
  rawRate:       ExchangeRate; // Full rate object from the provider
  inputAmount:   Decimal;  // Amount entering this leg
  outputAmount:  Decimal;  // Amount leaving this leg (pre-bucket-rounding)
  rounded:       boolean;  // Whether intermediate rounding was applied
  hopIndex:      number;   // 0-based position in the chain
}
```

`FxHop` records are attached to `FxConversionResult.hops`.  Direct and inverse
conversions always have `hops: []`.

---

## `FxConversionResult` — updated fields

| Field | Change |
|-------|--------|
| `hops: FxHop[]` | **New.** Empty for direct/identity conversions; 2 entries for a single-via triangulation. |

All other fields are unchanged.

---

## `triangulate()` — updated signature

```typescript
async triangulate(
  amount: Decimal,
  from: string,
  to: string,
  viaOrVias: string | string[],   // was: baseCurrency: string
  options?: { bucketIncrement?, side?, maxRateAgeMs? }
): Promise<FxConversionResult>
```

**`viaOrVias`** accepts either a single reference currency (`'USD'`) or an
ordered list of candidates (`['CHF', 'USD']`).  The first candidate for which
**both legs are available** wins.  If all candidates fail, an actionable error
is thrown.

---

## Max-Hop Configuration

```typescript
const engine = new FxConversionEngine(rateProvider, {
  maxHops: 2,   // default; must be integer ≥ 1
});
```

A single-via triangulation (A→B→C) counts as **2 hops**.  If the requested
chain exceeds `maxHops`, an actionable `AppError` is thrown:

```
Triangulation requires 2 hops but maxHops is 1.
Add a direct rate for EUR/JPY or increase maxHops.
```

The error tells the operator exactly which direct rate to add to the provider
so the max-hop budget can be respected.

---

## Alternate Reference Currency Fallback

When a list of candidates is supplied, the engine tries each in order:

```typescript
const result = await engine.triangulate(
  amount, 'EUR', 'JPY',
  ['CHF', 'USD']   // try CHF first, fall back to USD
);
```

| Scenario | Behaviour |
|----------|-----------|
| First candidate both legs available | Used immediately; fallback never attempted |
| First candidate leg 1 missing | Silent skip; next candidate tried |
| First candidate leg 2 missing | Silent skip; next candidate tried |
| First candidate leg is **stale** | Error propagated immediately; no fallback |
| All candidates exhausted | `serviceUnavailable` with list of missing pairs |

Stale rates are treated as hard errors (not silent skips) because they
represent a data quality failure that should be surfaced to operators rather
than masked by a different route.

The error message when all candidates fail includes:
- All tried via currencies
- All missing pair identifiers
- Guidance to "configure an alternate reference currency"

---

## Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `fx_triangulations_total` | counter | `from`, `to`, `via` | Successful triangulations |
| `fx_triangulation_hops` | histogram | `from`, `to`, `via` | Actual hop count per triangulation |
| `fx_stale_rate_rejected_total` | counter | `pair` | Stale-rate rejections (existing) |
| `fx_conversions_total` | counter | `from`, `to`, `side` | All direct conversions (existing) |

`fx_triangulation_hops` is emitted with the number of hops in the resolved
chain (always 2 for single-via).  Multi-via chains that resolve on the first
candidate also emit 2.

---

## Hop Audit — Attaching to Payout Records

Per-hop data should be serialised and stored alongside the payout record so
auditors can trace the full derivation:

```typescript
const fx = await engine.triangulate(amount, 'EUR', 'JPY', 'USD');

await db.query(
  `UPDATE payouts
   SET fx_rate          = $1,
       fx_path          = $2,
       fx_hops          = $3,
       fx_computed_at   = NOW()
   WHERE id = $4`,
  [
    fx.rate.mid.toString(),          // combined synthetic rate
    fx.path.description,             // "EUR→USD→JPY"
    JSON.stringify(fx.hops.map(h => ({
      from:          h.from,
      to:            h.to,
      side:          h.side,
      effectiveRate: h.effectiveRate.toString(),
      inputAmount:   h.inputAmount.toString(),
      outputAmount:  h.outputAmount.toString(),
      rawRatePair:   h.rawRate.pair,
      rawRateMid:    h.rawRate.mid.toString(),
      rawRateTs:     h.rawRate.timestamp.toISOString(),
      hopIndex:      h.hopIndex,
    }))),
    payoutId,
  ]
);
```

The recommended schema addition is:

```sql
ALTER TABLE distribution_payouts
  ADD COLUMN IF NOT EXISTS fx_path   TEXT        NULL,
  ADD COLUMN IF NOT EXISTS fx_hops   JSONB       NULL,
  ADD COLUMN IF NOT EXISTS fx_computed_at TIMESTAMPTZ NULL;
```

---

## Security Assumptions

1. **Rates are never fabricated.** `effectiveRate` is always derived from the
   `rawRate` returned by the provider — no inline rate overrides are accepted.

2. **Stale rates are hard errors.** A stale rate on any leg causes an immediate
   error, even when alternate reference currencies are available.  This prevents
   silently routing through an outdated price.

3. **max-hop is enforced before any provider call.** An excessively long chain
   fails fast without hitting the rate provider, preventing unbounded I/O.

4. **Intermediate amounts are not rounded between legs.** `bucketIncrement` is
   only applied on the final output.  Each leg's intermediate result is passed
   unrounded into the next leg to preserve precision.  The `rounded` flag in
   each `FxHop` reflects only whether the intermediate default rounding was
   triggered, not a deliberate truncation.

5. **No injection via currency codes.** Currency codes are used as map keys and
   log labels only — never as SQL values or shell arguments.

---

## Abuse and Failure Paths

| Scenario | Behaviour |
|----------|-----------|
| `from === to` | Identity conversion; no provider call; `hops: []` |
| `from === via` or `to === via` | Direct conversion; `hops: []` |
| Direct rate missing, inverse available | Inverse used automatically (existing behaviour) |
| All vias exhausted | `serviceUnavailable` with actionable message |
| `maxHops` exceeded | `badRequest` with "add direct rate or increase maxHops" |
| `maxHops: 0` at construction | Throws synchronously: "maxHops must be a positive integer ≥ 1" |
| Provider throws mid-triangulation | Propagated as-is |
| Zero or negative amount | `badRequest` (existing behaviour) |

---

## Related Documents

- [`docs/fx-provider-health-scoring.md`](fx-provider-health-scoring.md)
- [`docs/distribution-engine-atomic-transactions.md`](distribution-engine-atomic-transactions.md)
- [`docs/payout-batching-edge-cases.md`](payout-batching-edge-cases.md)
