# Holiday Calendar Blackout Support

Implements [issue #664](https://github.com/RevoraOrg/Revora-Backend/issues/664):
jurisdiction-aware bank-holiday blackouts for the distribution scheduler, loaded
from a signed static file with per-jurisdiction overrides and a fallback shift
policy (previous vs next business day).

## Overview

`HolidayCalendarService` answers two questions for the scheduler:

1. `isBlackout(date, jurisdictions)` — is this a blackout day?
2. `getShiftedDate(date, jurisdictions)` — which settleable day should a
   distribution window scheduled for `date` actually run on?

Distribution windows skip blackout days so investor bank rails receive funds on
a settleable business day.

## Security model

| Control | Behaviour |
|---------|-----------|
| Signed static file | Calendar is distributed as `{ payload, signature }` where `payload` is base64-encoded JSON and `signature` is `sha256=<hmac-hex>` |
| Signature validation first | HMAC-SHA256 is verified with `crypto.timingSafeEqual` **before** the payload is applied (fail-closed) |
| Audit hash | SHA-256 of the canonical payload is persisted in a `holiday_calendar.load` audit event |
| Secret handling | `HOLIDAY_CALENDAR_SECRET` is never logged |
| Fail-closed | Missing file, bad signature, malformed payload, or empty secret rejects the whole calendar |

## Shift semantics (strictest shift)

- A blackout day is shifted to the previous or next business day per
  `HOLIDAY_FALLBACK_SHIFT_POLICY` (default: `previous`).
- The shifted date must itself be settleable: it must not fall on a weekend
  **and** must not be a blackout for **any** jurisdiction in the distribution.
- Overlapping holidays across jurisdictions therefore keep shifting until every
  affected jurisdiction can settle on the same day.
- Per-jurisdiction overrides (e.g. `US-NY`) augment the base holiday set.

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HOLIDAY_CALENDAR_FILE_PATH` | No | (empty) | Absolute path to the signed static calendar |
| `HOLIDAY_CALENDAR_SECRET` | No | (empty) | HMAC secret for validating the calendar signature |
| `HOLIDAY_FALLBACK_SHIFT_POLICY` | No | `previous` | Shift direction: `previous` or `next` |

## Calendar file format

```json
{
  "payload": "<base64-encoded JSON>",
  "signature": "sha256=<hex>"
}
```

Decoded payload:

```json
{
  "version": "1.0.0",
  "jurisdictions": {
    "US": ["2026-01-01", "2026-12-25"],
    "GB": ["2026-01-01", "2026-04-02"]
  },
  "overrides": {
    "US-NY": ["2026-01-02"]
  },
  "generatedAt": "2026-01-01T00:00:00Z"
}
```

### Generating a signed calendar

```typescript
import { createHmac } from 'crypto';

const payload = {
  version: '1.0.0',
  jurisdictions: { US: ['2026-01-01'] },
  overrides: {},
  generatedAt: new Date().toISOString(),
};
const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
const signature = `sha256=${createHmac('sha256', process.env.HOLIDAY_CALENDAR_SECRET!)
  .update(base64)
  .digest('hex')}`;
```

## Integration

```typescript
import { HolidayCalendarService } from './services/holidayCalendarService';
import { DistributionScheduler } from './services/distributionScheduler';

const calendar = new HolidayCalendarService({
  fallbackShiftPolicy: 'previous',
  auditRepository,
  metrics,
});
await calendar.loadCalendar(
  process.env.HOLIDAY_CALENDAR_FILE_PATH!,
  process.env.HOLIDAY_CALENDAR_SECRET!,
);

const scheduler = new DistributionScheduler(engine, revenueReportRepo, {
  holidayCalendarService: calendar,
});
```

When a claim's `period_end` is a blackout for the offering's jurisdiction, the
scheduler shifts the distribution window and logs the decision.

## Metrics

- `scheduler.blackout.shift` (counter, labels: `direction`, `jurisdiction_count`)
  — emitted once per shift decision. Sanitized storage name:
  `scheduler_blackout_shift`.

## Abuse / failure paths

| Scenario | Behaviour |
|----------|-----------|
| Missing / unreadable file | `loadCalendar` throws; service stays uninitialized |
| Invalid HMAC signature | Rejected; service stays uninitialized |
| Malformed JSON / base64 / payload | Rejected; service stays uninitialized |
| Empty secret | Rejected immediately |
| Unknown jurisdiction | No shift (ignored) |
| Adjacent business day also a holiday | Keep shifting until settleable |
| Audit repository down | Load continues; warning logged |

## Tests

```bash
npx jest src/services/holidayCalendarService.test.ts src/services/distributionScheduler.test.ts
```

Covers signature validation (including wrong-secret), blackout detection with
overrides, previous/next policies, weekend skipping, overlapping multi-
jurisdiction strictest shift, metric emission, and audit persistence.
