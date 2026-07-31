# Investor Statement PDF i18n Legal Disclaimers (Issue #673)

## Overview

Investor PDF statements now render legal disclaimers in the recipient's locale,
with locale-keyed disclaimer bundles and per-locale header/footer templates.
Unsupported locales fall back to `en-US` with a `pdf_locale_fallback` counter
emission.

## Supported Locales

| Locale | Header Language | Jurisdiction |
|--------|----------------|-------------|
| `en-US` | English | US (Reg D, Securities Act of 1933) |
| `de-DE` | German | EEA (MiFID II - Richtlinie 2014/65/EU) |
| `fr-FR` | French | EEA (MiFID II - Directive 2014/65/UE) |
| `ja-JP` | Japanese | Japan (FSA - 金融商品取引法) |
| `es-ES` | Spanish | EEA (MiFID II - Directiva 2014/65/UE) |

## Architecture

```
src/i18n/disclaimerBundles.ts    → Bundle types, pinned bundles, loader
src/services/statementPdfService.ts → PDF rendering with locale-awareness
src/services/statementPdfService.test.ts → Comprehensive tests (66 passing)
```

### Bundle Structure

Each `LocaleDisclaimerBundle` contains:
- `locale` — IETF BCP 47 tag
- `headerText` — Confidential header rendered at page top
- `footerText` — Legal notice appended after ledger revision stamp
- `disclaimers` — Ordered list of `{ jurisdiction, text }` entries

### Hash Pinning

Bundles are immutable resources with SHA-256 hash pinning. The pin map
(`BUNDLE_HASH_PINS`) is verified lazily on first bundle access. Production
deployments should call `revalidateBundleHashes()` at startup.

To update a bundle:
1. Edit the bundle content in `src/i18n/disclaimerBundles.ts`
2. Run `computeAllBundleHashes()` to get new hash values
3. Update `BUNDLE_HASH_PINS` with the new hashes
4. Submit for code review (legal text changes require audit trail)

## Usage

### Direct Rendering

```typescript
import { renderStatementPdfDetails } from './services/statementPdfService';

const result = renderStatementPdfDetails(job, {
  locale: 'de-DE',           // Requested locale
  metrics: metricsCollector,  // Optional: emits fallback counter
});
// result.disclaimerBundle → LocaleDisclaimerBundle (resolved)
// result.localeFallback    → boolean (true if fallback occurred)
```

### Batch Worker (via StatementRenderOptions)

```typescript
const worker = new StatementPdfBatchWorker(jobRepo, renderFn, metrics, {
  renderOptions: { locale: 'en-US' },
});
```

## Fallback Behavior

| Input | Resolved Locale | Fallback? | Counter Emitted? |
|-------|----------------|-----------|-----------------|
| `'en-US'` | `en-US` | No | No |
| `'de-DE'` | `de-DE` | No | No |
| `'zh-CN'` | `en-US` | Yes | Yes (`pdf_locale_fallback`) |
| `''` (empty) | `en-US` | Yes | Yes |
| `'any'` | `en-US` | Yes | Yes |
| `'en'` (bare) | `en-US` | No | No |
| `'en_US'` | `en-US` | No | No |
| `undefined` | `en-US` | No | No |

## Metrics

- **`pdf_locale_fallback`** (counter): Incremented when locale falls back to en-US.
  Labels: `requested_locale`, `resolved_locale`.

## Security Assumptions

- Legal disclaimer text is immutable after hash pinning; any change requires
  code review and hash re-pinning.
- `en-US` is the root-of-trust locale — the loader throws if it is absent.
- Missing-locale fallback is graceful: rendering succeeds with a fallback
  counter, never fails.
- Hash verification runs lazily on first access to avoid blocking module load.
  Production deployments should verify at startup.

## Test Coverage

66 tests covering:
- Per-locale golden text verification (header, footer, disclaimers)
- Fallback behavior for unsupported, empty, and `'any'` locales
- Bare language code normalization (`en` → `en-US`)
- Underscore-separated variant normalization (`en_US` → `en-US`)
- Lowercase variant normalization (`de-de` → `de-DE`)
- `pdf_locale_fallback` counter emission and non-emission
- Logger emission on fallback (`globalLogger.info`)
- No crash when `metrics` option is omitted
- `makeStatementRenderFn` integration with locale options
- Option merging (default locale overridden by per-call locale)
