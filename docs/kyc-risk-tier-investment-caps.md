# KYC Risk-Tier Investment Caps

## Overview

Investment concentration caps were previously static per offering
(`offerings.max_investor_share_bps`). This feature adds a **per-investor**
dynamic adjustment driven by `users.kyc_risk_tier`, so higher-risk investors
face a lower effective cap on **new** investment intents.

Cap changes (tier upgrades/downgrades) **never retroactively invalidate**
existing investments. A previously blocked intent is re-evaluated only on the
next `createInvestment` call after the tier change.

---

## Risk tiers and multipliers

| Tier         | Multiplier on offering `max_investor_share_bps` | Notes |
|--------------|--------------------------------------------------|-------|
| `low`        | 1.0                                              | Full offering cap |
| `standard`   | 1.0                                              | Default for new users |
| `elevated`   | 0.5                                              | Half offering cap |
| `high`       | 0.25                                             | Quarter offering cap |
| `restricted` | 0                                                | Blocks all new capital (even if offering has no static cap) |

`effective_cap_bps = floor(offering_cap_bps × multiplier)`, clamped to `[0, 10000]`.

When the offering has **no** static cap (`NULL`):

- Non-`restricted` tiers → unlimited (no concentration check)
- `restricted` → effective cap `0` (new intents blocked)

---

## Implementation

| Piece | Path |
|-------|------|
| Migration | `src/db/migrations/016_add_kyc_risk_tier_to_users.sql` |
| Pure resolver | `src/lib/kycRiskTierCaps.ts` |
| Tier update + audit | `src/services/kycRiskTierService.ts` |
| Cap gate on invest | `src/services/investmentService.ts` (`assertKycTierCap`) |
| Admin API | `PATCH /api/admin/investors/:id/kyc-risk-tier` |

### `resolveEffectiveCap(offeringCapBps, tier)`

Returns `{ tier, multiplier, offeringCapBps, effectiveCapBps }`.

### `evaluateInvestmentAgainstCap({ existingTotal, newAmount, totalOfferingAmount, resolution })`

Pure allow/deny for a single intent. Callers supply the existing commitment total;
this module never mutates investment rows.

### `KycRiskTierService.updateKycRiskTier`

Persists the new tier and emits audit action **`investor.cap.recalculated`** with:

- `previous_tier`, `new_tier`, `multiplier`, `effective_cap_bps`
- `retroactive_invalidation: false`
- `changed: boolean`

---

## Security assumptions

1. Only **admin** callers may change `kyc_risk_tier` (`requireAdmin` on the admin route).
2. Cap enforcement runs inside `InvestmentService.createInvestment` before insert.
3. Existing investments are never deleted, reduced, or status-flipped by a tier change.
4. Investors cannot self-elevate their tier via the public investment API.
5. Invalid / missing tier values coerce to `standard` when read from the DB
   (`parseKycRiskTier`), preventing accidental lockouts from corrupt rows.
6. Audit emission uses `SecurityAuditRepository` (same pattern as AML).

---

## Abuse and failure paths

| Scenario | Behaviour |
|----------|-----------|
| High-risk investor exceeds adjusted cap | `403` with KYC risk-tier adjusted cap message |
| `restricted` investor, any positive amount | `403` (effective cap 0) |
| Tier upgraded after a blocked intent | Next `createInvestment` re-checks; may succeed if under new cap |
| Tier downgraded after large commitment | Existing rows kept; further amounts blocked if over new cap |
| Offering has `NULL` cap, non-restricted tier | Allowed (unlimited) |
| Non-investor user id on tier update | `400` validation error |
| Unknown investor on tier update | `404` |
| Unauthenticated admin tier patch | `401` |
| Non-admin role on tier patch | `403` |

---

## Test coverage

| File | Focus |
|------|-------|
| `src/lib/__tests__/kycRiskTierCaps.test.ts` | Multipliers, boundaries, upgrade-on-next-intent, no retroactive clawback semantics |
| `src/services/__tests__/kycRiskTierService.test.ts` | Tier update + `investor.cap.recalculated` audit |
| `src/services/investmentService.test.ts` | Service wiring: block / allow-after-upgrade / restricted / no DELETE |

Target: ≥95% coverage on new modules (`kycRiskTierCaps.ts`, `kycRiskTierService.ts`).

---

## Example usage

```http
PATCH /api/admin/investors/investor-1/kyc-risk-tier
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{ "tier": "high", "offering_cap_bps": 1000 }
```

```json
{
  "investor_id": "investor-1",
  "previous_tier": "standard",
  "kyc_risk_tier": "high",
  "effective_cap_bps": 250,
  "multiplier": 0.25,
  "retroactive_invalidation": false
}
```

---

## Related files

- `src/lib/investmentConsistencyGuard.ts` — static concentration cap (FOR UPDATE path)
- `docs/investment-consistency-checks.md` — offering-status consistency rules
- `docs/aml-transaction-monitoring.md` — audit / compliance patterns
