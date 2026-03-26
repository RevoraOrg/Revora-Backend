# Milestone Event Publishing Reliability

## Overview

This change hardens milestone-domain event publishing by introducing a reliability wrapper in `src/index.ts` around `DomainEventPublisher`.

The previous implementation published directly to transport (`console.log` in local mode), which meant transient publisher failures could surface as request failures with no retry semantics.

The new flow is:

1. Milestone validation accepts and enqueues the domain event.
2. A background processor attempts delivery with bounded retries and exponential backoff.
3. Exhausted events are moved into an in-memory dead-letter buffer.
4. `/health` exposes publisher reliability telemetry and marks service degraded when dead letters exist.

## Reliability Model

- Delivery semantics: **at-least-once** within process lifetime.
- Acceptance semantics: request succeeds when event is accepted into in-memory queue.
- Retry policy: bounded retries with exponential backoff.
- Idempotency: duplicate event submissions are deduplicated by computed event key.
- Failure isolation: repeated publish failures do not crash API request handling.

## Security and Abuse Assumptions

- Event names are validated against a strict pattern (`[a-z0-9._-]`), preventing malformed event-channel usage.
- Payloads must be plain objects (non-array), preventing ambiguous transport shapes.
- Queue is bounded to avoid unbounded memory growth under abuse.
- Queue overflow does not panic the process; overflowed events are dead-lettered and surfaced in health status.
- Dead-letter buffer is bounded to avoid memory exhaustion.

## Failure Paths and Behavior

### Publisher transport fails transiently

- Event remains queued.
- Retry is scheduled using exponential backoff.
- Health remains observable with queue depth and `lastError`.

### Publisher transport fails repeatedly

- Event is moved to dead-letter after `maxAttempts`.
- `/health` returns `503` with `status: degraded` while dead-letter backlog exists.

### Duplicate publish attempts

- Deduplication short-circuits duplicate enqueue/publish attempts for the same event identity.

## Operational Notes

- Current queue and dead-letter storage are process-local and non-durable.
- A process restart clears in-memory queue and dead letters.
- For multi-instance or strict durability, move queue/dead-letter to durable storage (e.g. DB-backed outbox).

## Configuration

The reliability wrapper supports the following environment variables:

- `MILESTONE_EVENT_PUBLISH_MAX_ATTEMPTS`
- `MILESTONE_EVENT_PUBLISH_RETRY_BASE_MS`
- `MILESTONE_EVENT_PUBLISH_QUEUE_CAPACITY`
- `MILESTONE_EVENT_PUBLISH_DEAD_LETTER_CAPACITY`
- `MILESTONE_EVENT_PUBLISH_DEDUPE_TTL_MS`

Defaults are tuned for fast deterministic retries in test mode and safer latency in non-test mode.

## Test Strategy

`src/routes/health.test.ts` now verifies:

- health endpoint includes event-reliability metrics.
- successful milestone validation drains publish queue and records publish timestamp.
- verifier auth boundary remains enforced.
- deterministic forced transport failures result in dead-lettering and degraded health state.

