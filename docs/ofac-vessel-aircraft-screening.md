# OFAC Vessel & Aircraft Screening for Offering Counterparty Metadata

> **Implements:** Issue #542  
> **Rule type:** `ofac_counterparty_screening`  
> **Affected file:** `src/aml/ruleEvaluator.ts`  
> **Branch:** `feat/ofac-vessel-aircraft-screen`

---

## Overview

OFAC's Specially Designated Nationals (SDN) list includes not only individuals and
companies but also **vessels** and **aircraft** that can appear as counterparty
metadata on investment offerings (e.g., a collateralised cargo-shipping offering
whose underlying asset is a sanctioned vessel).

This document describes the `ofac_counterparty_screening` AML rule type that
extends the existing sanctions-screening engine to cover these non-person entity
classes with proper type-filtering, validated IMO surfacing, and structured match
reasons on the alert.

---

## Entity Taxonomy

```typescript
type OfacEntityType = 'person' | 'vessel' | 'aircraft' | 'organisation';
```

| Type | OFAC list section | Key identifier |
|---|---|---|
| `vessel` | Vessel SDN entries | IMO number (`IMOxxxxxxx`) |
| `aircraft` | Aircraft SDN entries | Aircraft tail number (future) |
| `organisation` | Entity / company SDN entries | Legal name |
| `person` | **Person queue only** — NOT screened by this rule | N/A |

> **Note:** `person`-type counterparties in `context.counterparties[]` are silently
> skipped by this rule. Person screening uses the separate `sanctions_screening` rule
> (investor-name queue). This is intentional to prevent cross-type false-positive noise.

---

## Rule Configuration

```typescript
interface OfacVesselAircraftRuleConfig {
  /** Names from the OFAC SDN vessel/aircraft/entity list. */
  sanctions_list: string[];

  /**
   * Jaro-Winkler similarity threshold for fuzzy matching.
   * Default: 0.85. Overridable per-tenant via context.tenant_settings.sanctions_threshold.
   */
  jaro_winkler_threshold?: number;

  /**
   * When false, only exact (normalised string equality) matches trigger.
   * Default: true.
   */
  fuzzy_enabled?: boolean;

  /**
   * Optional whitelist of entity types to screen.
   * When omitted, all entity types are screened.
   * Example: ['vessel'] — only vessels are checked, aircraft are skipped.
   */
  entity_types?: OfacEntityType[];
}
```

### Example Rule Definition

```json
{
  "name": "OFAC Vessel & Aircraft Screening",
  "description": "Screens offering counterparties against OFAC SDN vessel, aircraft and entity lists",
  "type": "ofac_counterparty_screening",
  "severity": "critical",
  "config": {
    "sanctions_list": ["Arktika Star", "Rakhsh", "Mahan Air"],
    "jaro_winkler_threshold": 0.85,
    "fuzzy_enabled": true,
    "entity_types": ["vessel", "aircraft", "organisation"]
  }
}
```

---

## TransactionContext Extension

```typescript
interface TransactionContext {
  // ... existing fields ...

  /**
   * Non-person counterparties attached to the offering being invested in.
   * Each entry is independently screened by the `ofac_counterparty_screening` rule.
   */
  counterparties?: OfacCounterparty[];
}

interface OfacCounterparty {
  /** Legal or registered name of the counterparty. */
  name: string;
  /** Entity class; controls which OFAC sub-list is searched. */
  type: OfacEntityType;
  /**
   * IMO vessel/ship identification number.
   * Format: `IMO` followed by exactly 7 digits (e.g., `IMO9876543`).
   * Validated before surfacing; invalid values are dropped silently.
   */
  imo_number?: string;
}
```

---

## Alert Details Payload

When the rule triggers, `RuleEvaluationResult.details` contains:

```typescript
{
  screened_count: number;   // Total counterparties examined
  matched: true;
  match_count: number;      // Number of SDN hits
  threshold: number;        // Effective Jaro-Winkler threshold used
  action: 'auto_deny' | 'pending_review'; // Worst-case action across all hits
  matches: OfacScreeningMatch[]; // One entry per hit
}
```

Each `OfacScreeningMatch` entry:

```typescript
{
  screened_name: string;        // Counterparty name that was screened
  entity_type: OfacEntityType;  // 'vessel' | 'aircraft' | 'organisation'
  imo_number?: string;          // Only present when validated format passes
  matched_candidate: string;    // Best-matching SDN list entry
  similarity_score: number;     // 1.0 for exact, <1.0 for fuzzy
  match_type: 'exact' | 'fuzzy';
  match_reason: string;         // e.g. 'ofac_vessel_exact', 'ofac_aircraft_fuzzy'
  action: 'auto_deny' | 'pending_review';
}
```

### `match_reason` Format

```
ofac_<entity_type>_<match_type>
```

Examples: `ofac_vessel_exact`, `ofac_aircraft_fuzzy`, `ofac_organisation_exact`.

---

## Security Assumptions

### 1. Strict Person-Queue Isolation

The `ofac_counterparty_screening` evaluator (`evaluateOfacCounterpartyRule`) and the
person-queue sanctions evaluator (`evaluateSanctionsRule`) are **completely separate
code paths** dispatched from independent `switch` cases. A vessel counterparty whose
name collides with an SDN person entry does **not** cause the person-alert queue to
trigger, and vice versa.

### 2. IMO Number Validation

IMO numbers provided by calling code are treated as **untrusted input**. Before being
echoed into alert details, each value must match `/^IMO\d{7}$/` (the letter sequence
`IMO` followed by exactly 7 digits, per IMO resolution A.600(15)).

- A counterparty with an **invalid** IMO format is still screened by name.
- The invalid IMO value is **silently dropped** from alert details — it is never
  persisted or forwarded downstream.
- This prevents metadata injection (e.g., a forged `imo_number` containing script
  payloads or SQL fragments) from reaching alert consumers.

### 3. Type-Filtered Matching

When `config.entity_types` is set, counterparties whose `type` is not in the filter
are **skipped entirely** — they are not screened and do not appear in `details`.
This prevents an aircraft rule from generating vessel hits (cross-type noise) and
gives compliance teams narrow, auditable rule scopes.

### 4. Fuzzy Match → Pending Review (Never Auto-Deny)

Consistent with the existing sanctions rule:
- **Exact match** → `action: 'auto_deny'`
- **Fuzzy match** → `action: 'pending_review'` (requires analyst clearance)

This prevents automated denial based on approximate string similarity, which is
inherently probabilistic and error-prone.

### 5. No Early Return on First Hit

All counterparties are evaluated before returning. This ensures that analysts see
the **complete match set** on the alert, avoiding partial investigation from the
first hit masking subsequent ones.

---

## Abuse and Failure Paths

| Path | Behaviour | Mitigation |
|---|---|---|
| Forged `imo_number` with SQL/script payload | Dropped silently; counterparty screened by name only | Regex validation before echo |
| Counterparty array contains `type: 'person'` | Skipped (person-queue is separate) | Type-filter in evaluator |
| Empty `sanctions_list` | Returns `triggered: false`, reason logged | Guard clause at method entry |
| `counterparties` field missing | Treated as `[]`, returns `triggered: false` | Nullish coalescing `?? []` |
| Very large `counterparties[]` | O(n × m) where n=counterparties, m=sanctions_list; acceptable at current scale | Document as known constraint |
| Tenant sets `sanctions_threshold: 0` | Every fuzzy match triggers; creates noise | Validate threshold > 0 at rule creation (future work) |
| Fuzzy disabled + no exact match | Returns `triggered: false` cleanly | Tested in scenario 13 |

---

## Testing

New test suite: **`OFAC Counterparty Screening — Vessel & Aircraft`** in
[`src/aml/ruleEvaluator.test.ts`](file:///c:/Users/USER/Drips/Revora-Backend/src/aml/ruleEvaluator.test.ts)

| # | Scenario |
|---|---|
| 1 | Vessel exact name match → `match_reason='ofac_vessel_exact'`, `action='auto_deny'` |
| 2 | Valid IMO surfaced in `details.matches[0].imo_number` |
| 3 | Aircraft fuzzy match → `match_reason='ofac_aircraft_fuzzy'`, `action='pending_review'` |
| 4 | Organisation exact match → `entity_type='organisation'` |
| 5 | `entity_types=['vessel']` filter skips aircraft counterparty |
| 6 | Person-queue (`sanctions_screening`) not triggered by vessel counterparty name |
| 7 | Invalid IMO format dropped; counterparty still screened by name |
| 8 | Empty counterparties array → `triggered=false`, reason in details |
| 9 | Undefined `counterparties` field → `triggered=false` gracefully |
| 10 | All counterparties clear → `triggered=false`, `screened_count` correct |
| 11 | One sanctioned counterparty among multiple clean ones → `match_count=1` |
| 12 | Per-tenant `sanctions_threshold` overrides rule config for fuzzy matching |
| 13 | `fuzzy_enabled=false` → exact match still triggers; near-miss does not |

### Running Tests

```bash
# Targeted (evaluator only)
npx jest src/aml/ruleEvaluator.test.ts --coverage

# Full suite
npm test
```

---

## Related Documentation

- [`docs/aml-transaction-monitoring.md`](file:///c:/Users/USER/Drips/Revora-Backend/docs/aml-transaction-monitoring.md) — AML system overview
- [`docs/sanctions-screening-fuzzy-matching.md`](file:///c:/Users/USER/Drips/Revora-Backend/docs/sanctions-screening-fuzzy-matching.md) — Jaro-Winkler matching details
- [`docs/ofac-signed-source.md`](file:///c:/Users/USER/Drips/Revora-Backend/docs/ofac-signed-source.md) — OFAC list ingestion and signature verification
- [OFAC SDN List FAQ](https://ofac.treasury.gov/faqs/topic/1521)
- [IMO Ship Identification Number Scheme](https://www.imo.org/en/OurWork/MSAS/Pages/IMO-identification-number-scheme.aspx)
