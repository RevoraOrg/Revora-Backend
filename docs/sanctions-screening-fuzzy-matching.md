# Sanctions Screening Fuzzy-Match Tuning with Configurable Jaro-Winkler Threshold

## Overview

The Sanctions Screening Fuzzy-Match capability enhances AML compliance monitoring by supplementing exact name matching with a Jaro-Winkler fuzzy string comparison algorithm. This detects transliteration variants (such as Cyrillic-to-Latin variations) while eliminating blind spots caused by minor spelling differences or formatting variations.

## Key Security Assumptions & Guarantees

1. **Pending Review for Fuzzy Matches**:
   - **Exact Matches (`match_type: 'exact'`)**: Automatically flagged as critical risk (`action: 'auto_deny'`).
   - **Fuzzy Matches (`match_type: 'fuzzy'`)**: Treated as **pending review only** (`action: 'pending_review'`, `auto_deny: false`, `review_status: 'pending_review'`). Fuzzy hits NEVER auto-deny transactions without human analyst review.

2. **Per-Tenant Threshold Configuration**:
   - The Jaro-Winkler threshold (default: `0.85`, range: `0.0 - 1.0`) can be tuned per tenant via `TenantSettingsService`.
   - Threshold priorities:
     1. Tenant setting override (`context.tenant_settings.sanctions_threshold`)
     2. Rule-level configuration (`rule.config.jaro_winkler_threshold`)
     3. System default fallback (`0.85`)

3. **Dual-Control Approval Workflow**:
   - Any modification to a tenant's Jaro-Winkler threshold requires **dual-control approval**.
   - **Propose (`proposeSanctionsThreshold`)**: An admin user proposes a threshold change with a mandatory justification. Status becomes `pending`.
   - **Approve (`approveSanctionsThreshold`)**: A second distinct admin user approves the proposal.
   - **Collusion Guard**: Enforces `proposer_id !== approver_id`. The user who proposed the threshold change is blocked from approving their own request.
   - **Reject (`rejectSanctionsThreshold`)**: Any authorized admin user can reject a pending change proposal.

4. **Transliteration & Normalization**:
   - Built-in Cyrillic-to-Latin character transliteration (ISO 9 standard variant).
   - Diacritic stripping (`NFD` normalization) and case-folding ensure names like *"Александр"* match *"Alexander"* with high similarity scores ($> 0.85$).

5. **Security Audit Logging**:
   - Every threshold proposal, approval, and rejection is recorded in the `SecurityAuditRepository` with full security context (user IDs, timestamps, previous & new thresholds).

## Architecture & Integration

- **Helper**: `src/lib/jaroWinkler.ts`
- **Rule Evaluator**: `src/aml/ruleEvaluator.ts` (`sanctions_screening` rule type)
- **Tenant Settings Service**: `src/services/tenantSettingsService.ts`
- **Unit Tests**:
  - `src/lib/jaroWinkler.test.ts`
  - `src/aml/ruleEvaluator.test.ts`
  - `src/services/__tests__/tenantSettingsService.test.ts`

## Example Usage

### Rule Configuration

```json
{
  "id": "rule_sanctions_01",
  "name": "Global Sanctions Watchlist Screening",
  "type": "sanctions_screening",
  "severity": "critical",
  "enabled": true,
  "config": {
    "sanctions_list": ["Alexander Petrov", "Vladimir Putin", "John Smith"],
    "jaro_winkler_threshold": 0.85,
    "fuzzy_enabled": true
  }
}
```

### Proposing and Approving Threshold Changes

```typescript
// Step 1: Admin A proposes threshold adjustment
const proposal = await tenantSettingsService.proposeSanctionsThreshold(
  "tenant_123",
  0.80,
  "admin_user_a",
  "Lower threshold to capture subtle Cyrillic transliteration variants"
);

// Step 2: Admin B (distinct identity) approves the change
const updatedTenant = await tenantSettingsService.approveSanctionsThreshold(
  "tenant_123",
  "admin_user_b"
);
```

## Testing & Verification

Run the test suite:

```bash
npx jest src/lib/jaroWinkler.test.ts src/aml/ruleEvaluator.test.ts src/services/__tests__/tenantSettingsService.test.ts
```
