# Holiday Calendar Blackout Support

## Overview

The `HolidayCalendarService` provides jurisdiction-specific bank holiday awareness for the distribution scheduler. Distribution windows skip blackout days so investor bank rails receive funds on a settleable business day.

## Key Concepts

- **Signed static file**: The calendar is loaded from a disk file containing a base64-encoded payload and an HMAC-SHA256 signature. This allows runtime updates without code changes while maintaining auditability.
- **Signature validation before application**: The HMAC signature is verified using constant-time comparison before any calendar data is applied. Invalid or tampered files are rejected entirely (fail-closed).
- **Per-jurisdiction overrides**: The calendar supports base holidays per jurisdiction and per-offering/jurisdiction overrides that augment or replace base holidays.
- **Strictest shift policy**: When overlapping holidays exist across multiple jurisdictions, any blackout triggers a shift.
- **Fallback shift policy**: Configurable as `previous` (default) or `next` business day.

## Environment Variables

| Variable                        | Required | Default    | Description                                          |
|---------------------------------|----------|------------|------------------------------------------------------|
| `HOLIDAY_CALENDAR_FILE_PATH`    | No       | (empty)    | Absolute path to the signed static holiday calendar   |
| `HOLIDAY_CALENDAR_SECRET`       | No       | (empty)    | HMAC secret for validating the calendar file signature|
| `HOLIDAY_FALLBACK_SHIFT_POLICY` | No       | `previous` | Shift direction: `previous` or `next` business day   |

## Calendar File Format

```json
{
  "payload": "<base64-encoded JSON>",
  "signature": "sha256=<hex>"
}
```

The base64 payload decodes to:

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

### Generating a Signed Calendar File

```typescript
import { createHmac } from 'crypto';

function signCalendar(payload: Record<string, unknown>, secret: string): string {
  const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const hmac = createHmac('sha256', secret);
  hmac.update(base64);
  return JSON.stringify({ payload: base64, signature: `sha256=${hmac.digest('hex')}` });
}
```

## Usage

### Basic Integration

```typescript
import { HolidayCalendarService } from './services/holidayCalendarService';

const calendar = new HolidayCalendarService({
  metrics: globalMetrics,
  auditRepository: auditRepo,
});

await calendar.loadCalendar('/secure/calendars/holidays.json', process.env.HOLIDAY_CALENDAR_SECRET!);

const decision = calendar.getShiftedDate(new Date('2026-01-31'), ['US']);
console.log(decision.shiftedDate); // 2026-01-30 (previous business day)
console.log(decision.reason);      // "Blackout in jurisdiction US"
```

### Scheduler Integration

```typescript
import { DistributionScheduler } from './services/distributionScheduler';
import { HolidayCalendarService } from './services/holidayCalendarService';

const scheduler = new DistributionScheduler(engine, revenueRepo, {
  holidayCalendarService: calendar,
  resolveJurisdiction: async (offeringId: string) => {
    // Resolve offering jurisdiction from database or cache
    const offering = await offeringRepo.findById(offeringId);
    return offering?.jurisdiction ?? null;
  },
});
```

## API Reference

### `HolidayCalendarService`

#### `loadCalendar(filePath: string, secret: string): Promise<void>`

Loads and validates a signed holiday calendar file. Must be called before `isBlackout` or `getShiftedDate`.

**Throws**:
- `Error` if file cannot be read.
- `Error` if signature verification fails.
- `Error` if payload is malformed.

#### `isBlackout(date: Date, jurisdictions: string[]): boolean`

Returns `true` if the date falls on a holiday in any of the provided jurisdictions.

#### `getShiftedDate(date: Date, jurisdictions: string[]): BlackoutShiftDecision`

Returns a shift decision. If the date is a blackout, computes the nearest business day per the configured fallback policy.

```typescript
interface BlackoutShiftDecision {
  originalDate: Date;
  shiftedDate: Date;
  shifted: boolean;
  reason: string;
  jurisdictions: string[];
  direction: 'previous' | 'next';
}
```

#### `isLoaded(): boolean`

Returns `true` if a calendar has been successfully loaded.

#### `getCalendarHash(): string | null`

Returns the SHA-256 hash of the canonical payload, or `null` if not loaded.

## Metrics

| Metric                          | Type   | Labels                     | Description                                      |
|---------------------------------|--------|----------------------------|--------------------------------------------------|
| `scheduler_blackout_shift_total`| counter| `direction`, `jurisdiction_count` | Count of distribution shifts due to blackout days |

## Audit Events

When the calendar is loaded, an audit event is persisted:

```typescript
{
  id: 'audit_...',
  type: 'VALIDATION',
  action: 'holiday_calendar.load',
  resource: 'holiday_calendar',
  outcome: 'SUCCESS' | 'FAILURE',
  details: {
    filePath: string,
    hash: string,
    version: string,
  },
  timestamp: Date,
}
```

## Security Considerations

- **Secret management**: Store `HOLIDAY_CALENDAR_SECRET` in a secrets manager. Never commit it to version control.
- **Constant-time comparison**: Signature validation uses `crypto.timingSafeEqual` to prevent timing attacks.
- **Fail-closed**: Invalid signatures or malformed files cause the calendar to be rejected entirely.
- **Hash persistence**: The calendar hash is recorded in an audit event for operational traceability and change detection.
- **No PII in logs**: File paths and hashes are logged; the secret is never logged.

## Abuse / Failure Paths

| Scenario                           | Behavior                                              |
|------------------------------------|-------------------------------------------------------|
| Missing file                       | `loadCalendar` throws; service remains uninitialized  |
| Invalid HMAC signature             | `loadCalendar` throws; service remains uninitialized  |
| Malformed JSON or base64 payload   | `loadCalendar` throws; service remains uninitialized  |
| Empty secret                       | `loadCalendar` throws immediately                     |
| Unknown jurisdiction               | Treated as non-holiday (no shift)                     |
| Overlapping holidays               | Shift applies if **any** jurisdiction is blacked out  |
| Weekend + holiday                  | Weekend days are also skipped as non-business days    |
