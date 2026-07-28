# Dispute SLA Timers with Automatic Escalation

## Overview

The dispute SLA timer system ensures that disputes do not age silently past regulatory response windows. It provides:

- **SLA timers per dispute state**: Each state transition starts a new timer with a jurisdiction-specific SLA duration.
- **Automatic escalation**: When an SLA timer is breached, an escalation notification is created and audit logged.
- **Pause/Resume**: Paused disputes do not consume SLA time; pause duration is accurately tracked and excluded.
- **Weekly SLA burn report**: CSV export of SLA compliance status with HMAC-SHA256 integrity signature.

## Architecture

```
┌──────────────┐    ┌─────────────────┐    ┌──────────────────┐
│  Routes      │───▶│  SLA Service     │───▶│  SLA Repository  │
│  (disputes)  │    │  (business logic)│    │  (PostgreSQL)    │
└──────────────┘    └─────────────────┘    └──────────────────┘
                            │
                            ├──▶ Notification Repository
                            ├──▶ Audit Log Repository
                            └──▶ SLA Config (per jurisdiction)
```

## Components

### 1. Migration (`src/db/migrations/012_create_dispute_slas.sql`)

Creates the `dispute_slas` table with:
- `dispute_id`: Reference to the dispute
- `jurisdiction`: Regulatory jurisdiction (US, EU, UK, CA, AU, SG, default)
- `state`: Current dispute state
- `sla_duration_hours`: Maximum allowed hours in this state
- `started_at`: When the timer started
- `paused_at`: If paused, when it was paused
- `total_paused_ms`: Accumulated pause time across all pause/resume cycles
- `escalated` / `escalated_at`: Escalation tracking
- `resolved_at`: When the timer was resolved (state transitioned)

### 2. SLA Configuration (`src/config/disputeSLAConfig.ts`)

Per-jurisdiction SLA durations mapped to regulatory requirements:

| Jurisdiction | Basis | Max Resolution Time |
|---|---|---|
| US | Reg E / Reg Z | 10 business days (~240h) |
| EU | PSD2 | 15 business days (~360h) |
| UK | FCA | 15 business days (~360h) |
| CA | FCAC | 56 calendar days (~1344h) |
| AU | AFCA | 30 calendar days (~720h) |
| SG | MAS | 20 business days (~480h) |
| default | Internal | 120h |

Each jurisdiction has configurable auto-escalation (enabled for all regulated jurisdictions, disabled for default).

### 3. Repository (`src/db/repositories/disputeSLARepository.ts`)

Database operations:
- `create()`: Create a new SLA record
- `findActiveByDisputeId()`: Find the active (unresolved) SLA for a dispute
- `findByDisputeId()`: Get SLA history for a dispute
- `update()`: Partial update of SLA fields
- `getSLABurnReport()`: Generate burn report with elapsed/remaining calculations
- `findOverdueNonEscalated()`: Find records past SLA deadline without escalation

### 4. Service (`src/services/disputeSLAService.ts`)

Core business logic:

- **`startTimer()`**: Begin SLA tracking for a dispute. Resolves any existing active timer. Rejects terminal states (resolved/closed).
- **`transitionState()`**: Move dispute to a new state, capturing SLA compliance of previous state and starting new timer.
- **`pauseTimer()`**: Pause SLA clock. Only active timers can be paused.
- **`resumeTimer()`**: Resume paused timer, accumulating pause duration. Checks for overdue SLA post-resume.
- **`escalate()`**: Mark SLA as breached, create notification, log audit event.
- **`escalateOverdue()`**: Batch-process all overdue non-escalated records (for cron/scheduler).
- **`exportBurnReportCSV()`**: Generate signed CSV report with HMAC-SHA256 signature.

### 5. Routes (`src/routes/disputes.ts`)

All endpoints require authentication:

| Method | Path | Description |
|---|---|---|
| `POST` | `/disputes/:disputeId/sla/start` | Start SLA timer |
| `POST` | `/disputes/:disputeId/sla/transition` | Transition dispute state |
| `POST` | `/disputes/:disputeId/sla/pause` | Pause SLA timer |
| `POST` | `/disputes/:disputeId/sla/resume` | Resume SLA timer |
| `GET` | `/disputes/sla/report` | Export SLA burn report (CSV) |

## CSV Burn Report

The CSV report includes:
- **HMAC-SHA256 signature** as a header comment for integrity verification
- **CSV injection prevention**: Cells starting with `=`, `+`, `-`, `@` are prefixed with `'`
- **Columns**: Dispute ID, Jurisdiction, State, SLA Duration, Elapsed Time, Remaining Time, Breached, Escalated, Paused, Started At, Resolved At, Assigned User
- **Caching prevention**: Cache-Control and Pragma headers set to prevent caching

Query parameters:
- `startDate` (required): ISO date string
- `endDate` (required): ISO date string
- `jurisdiction` (optional): Filter by jurisdiction

## Security Assumptions

1. **Authentication**: All dispute SLA endpoints require authentication via `requireAuth` middleware.
2. **Input validation**: All jurisdiction and state values are validated against allowed enumerations.
3. **CSV injection prevention**: Formula injection is blocked via cell sanitization.
4. **CSV integrity**: Reports are signed with HMAC-SHA256 using `SLA_REPORT_SIGNING_SECRET` env var.
5. **Audit trail**: All SLA operations (start, pause, resume, escalate, transition) are logged in the audit log.
6. **SQL injection safety**: All queries use parameterized inputs.

## Configuration

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `SLA_REPORT_SIGNING_SECRET` | HMAC key for CSV report signing | `revora-sla-default-secret` |

### Jurisdiction SLA Durations

SLA durations are defined in `src/config/disputeSLAConfig.ts` under `JURISDICTION_SLA_CONFIGS`. To modify durations:

1. Edit the `stateSLAs` map for the jurisdiction
2. All durations are in hours
3. Use `0` for terminal states (resolved, closed)

## Testing

```bash
# Run all dispute SLA tests
npm test -- src/config/disputeSLAConfig.test.ts src/services/disputeSLAService.test.ts src/routes/disputes.test.ts

# Run with coverage
npx jest --coverage src/config/disputeSLAConfig.test.ts src/services/disputeSLAService.test.ts src/routes/disputes.test.ts src/db/repositories/disputeSLARepository.ts
```

## Scheduling

The `escalateOverdue()` method should be called periodically (e.g., every 5 minutes via cron) to detect and escalate breached SLAs:

```typescript
// Example cron job (pseudocode)
setInterval(async () => {
  const service = new DisputeSLAService({ db: pool, ... });
  const escalated = await service.escalateOverdue();
  if (escalated.length > 0) {
    console.log(`Escalated ${escalated.length} overdue disputes`);
  }
}, 5 * 60 * 1000);
```
