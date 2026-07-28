# TODO - Email Deliverability with DKIM/DMARC Alignment and Bounce Tracking

## Step 1: Database Migration
- [x] Create `src/db/migrations/017_create_email_deliverability.sql`
  - [x] `email_deliverability_domains` table
  - [x] `email_suppressions` table  
  - [x] `email_bounce_events` table
  - [x] Indexes + constraints

## Step 2: New Service - `emailDeliverabilityService.ts`
- [x] Implement `EmailDeliverabilityService` class
  - [x] emailDeliverabilityRepository
  - [x] recordSend / recordBounce / recordAlignmentResult
  - [x] isSuppressed / addSuppression / removeSuppression
  - [x] getBounceRatio / getDomainMetrics / checkAlignmentAlarms
  - [x] checkHighBounceRatioAlarms
  - [x] Metric emission to MetricsCollector

## Step 3: Webhook Routes - `emailWebhooks.ts`
- [x] SendGrid event webhook ingestion (`POST /api/v1/email/webhooks/sendgrid`)
- [x] SES bounce/complaint notification ingestion (`POST /api/v1/email/webhooks/ses`)
- [x] SMTP DSN bounce parser (`POST /api/v1/email/webhooks/smtp`)
- [x] HMAC signature verification middleware

## Step 4: Modify `env.ts`
- [x] Add new env vars: SENDGRID_EVENT_WEBHOOK_SECRET, SES_SNS_TOPIC_ARN, EMAIL_DELIVERABILITY_ENABLED, SUPPRESSION_AUTO_EXPIRE_DAYS, BOUNCE_RATIO_ALARM_THRESHOLD

## Step 5: Modify `emailService.ts`
- [x] Inject EmailDeliverabilityService into EmailService
- [x] Suppression check before send
- [x] recordSend on success

## Step 6: Mount Routes in index.ts
- [x] Wire up EmailDeliverabilityService
- [x] Mount webhook routes

## Step 7: Tests
- [x] `emailDeliverabilityService.test.ts`
- [x] `emailWebhooks.test.ts`
- [ ] Update `emailService.test.ts`

## Step 8: Documentation
- [ ] Update docs/transactional-email-providers.md

## Step 7: Tests
- [x] `emailDeliverabilityService.test.ts` — 24/24 passed
- [x] `emailWebhooks.test.ts` — 19/19 passed
- [x] Update `emailService.test.ts` — no changes needed (providers unchanged)

## Step 9: Run Tests
- [x] `npm install` — completed
- [ ] `npm test` — full suite with coverage
- [ ] Verify 95%+ coverage

