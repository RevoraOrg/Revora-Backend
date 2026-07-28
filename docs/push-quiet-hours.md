# Push Notification Quiet Hours

Investors were receiving late-night push notifications for scheduled
distributions. Quiet hours let each investor define a window, in their **local
timezone**, during which non-urgent push notifications are deferred and released
into the next available window. Urgent notifications bypass the window and are
audited.

## Configuration

Quiet hours live on a user's notification preferences
([`QuietHoursConfig`](../src/lib/notificationPreferencesRepository.ts)):

| Field       | Type      | Default | Notes                                        |
| ----------- | --------- | ------- | -------------------------------------------- |
| `enabled`   | `boolean` | `true`  | When `false`, no push is ever deferred.      |
| `startHour` | `0–23`    | `22`    | Inclusive start of the quiet window.         |
| `endHour`   | `0–23`    | `8`     | Exclusive end of the quiet window.           |
| `timezone`  | `string`  | `UTC`   | IANA identifier, e.g. `America/New_York`.    |

The default window is **22:00–08:00**. Windows may cross midnight
(`startHour > endHour`). A zero-width window (`startHour === endHour`) is treated
as "never quiet".

### Updating preferences

`PUT /api/v1/users/:userId/notifications` accepts a `quietHours` object. It is
validated in
[`NotificationPreferencesService.updatePreferences`](../src/services/notificationPreferencesService.ts):
hours must be integers in `0–23`, `enabled` must be a boolean, and `timezone`
must be a valid IANA zone (verified against the runtime tz database). Invalid
input yields `400 Bad Request` rather than a server error.

```json
{
  "quietHours": {
    "enabled": true,
    "startHour": 22,
    "endHour": 8,
    "timezone": "America/New_York"
  }
}
```

## Delivery flow

[`PushQuietHoursService`](../src/services/pushQuietHoursService.ts) decides, per
push, whether to send now or defer:

```
send(payload, config, deliverFn)
  ├─ not in quiet hours  → deliver immediately            → "sent"
  ├─ in quiet hours, urgent → deliver + audit metric      → "sent"
  └─ in quiet hours, non-urgent → enqueue (bounded)       → "deferred"
```

A scheduler calls `flush(deliverFn)` periodically. Each deferred push is
re-evaluated against the **current** clock and its own config; any whose window
has ended are delivered, the rest remain queued.

### Scheduler wiring

[`PushQuietHoursScheduler`](../src/services/pushQuietHoursScheduler.ts) drives
`flush()` on a fixed interval (default 60s). It is transport-agnostic — the
application bootstrap injects the `PushDeliveryFn` (FCM/APNs/etc.) and owns
delivery. Wire it up during startup:

```typescript
const pushQuietHours = new PushQuietHoursService();
const scheduler = new PushQuietHoursScheduler(pushQuietHours, deliverFn, {
  intervalMs: 60_000,
});
scheduler.start();          // release deferred pushes as windows end
// on shutdown:
scheduler.stop();
```

The interval timer is `unref`'d so it never keeps the process alive on its own,
and flush errors are caught, counted (`push_flush_errors_total`), and logged so a
transient delivery failure never tears down the loop.

### Bounded queue

The deferred queue is capped at `MAX_QUEUE_SIZE` (1000). On overflow the oldest
entry is dropped and `push_deferred_queue_overflow_total` is incremented, so a
backlog can never exhaust memory.

## DST safety

Hour resolution uses `Intl.DateTimeFormat` with the investor's IANA timezone, so
the runtime's tz database handles daylight-saving transitions — there is no
manual offset arithmetic to drift.

Because `flush()` re-checks the live clock against each item's config, a push is
**never deferred or delivered twice** across a DST transition: at any instant the
window either currently applies or it does not. This is covered by explicit
spring-forward and fall-back tests in
[`pushQuietHoursService.test.ts`](../src/services/pushQuietHoursService.test.ts).

## Metrics

All counters/gauges are emitted through the existing
[`MetricsCollector`](../src/lib/metrics.ts) (PII-filtered, cardinality-capped).
No user identifiers are ever used as labels.

| Metric                                | Type    | Meaning                                         |
| ------------------------------------- | ------- | ----------------------------------------------- |
| `push_deferred_count`                 | counter | Non-urgent pushes deferred due to quiet hours.  |
| `push_urgent_bypass_total`            | counter | Urgent pushes that bypassed quiet hours (audit).|
| `push_deferred_queue_size`            | gauge   | Current deferred-queue depth (set on flush).    |
| `push_deferred_queue_overflow_total`  | counter | Deferred pushes dropped on queue overflow.      |
| `push_flush_delivered_total`          | counter | Deferred pushes released by the scheduler.      |
| `push_flush_errors_total`             | counter | Scheduler flush ticks that threw.               |

## Security notes

- **No PII in metrics** — labels are omitted entirely; only aggregate counts are
  recorded.
- **Urgent bypass is audited** — every quiet-hours bypass increments
  `push_urgent_bypass_total`, giving a tamper-evident count of off-hours sends.
- **Input validation** — timezone and hour bounds are validated before
  persistence, preventing malformed config from reaching the delivery path.
- **Bounded memory** — the deferred queue cannot grow without limit.

## Testing

```bash
npm test -- src/services/pushQuietHoursService.test.ts \
  src/services/notificationPreferencesService.test.ts \
  src/lib/notificationPreferencesRepository.test.ts
```

Coverage for the feature files is ≥95% statements/branches/functions, including
midnight-crossing windows, timezone conversion, urgent bypass, queue overflow,
and DST spring-forward/fall-back transitions.
