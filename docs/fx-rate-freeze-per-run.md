# FX Rate Freeze Windows Around Distributions

## Overview
FX rate changes mid-distribution cause reconciliation churn and variance between preview calculation and executed payouts. This document describes the rate-freeze mechanism that pins the exchange conversion rate for an entire distribution run and stores the pinned rate ID on both the distribution run and every generated payout record.

## Technical Architecture

### 1. Multi-Currency FX Engine (`src/services/fxConversionEngine.ts`)
- `freezeRate(context: string, from: string, to: string, side?: 'bid' | 'ask' | 'mid'): Promise<ExchangeRate>`
  - Pins rate for a specified context (`offeringId-periodId` or `runId`).
  - Idempotent: Subsequent calls with the same context return the existing frozen rate without re-fetching or creating duplicate rates.
- `getFrozenRate(context: string): ExchangeRate | null`
  - Retrieves the currently pinned rate for a given context.
- `setFrozenRate(context: string, rate: ExchangeRate): void`
  - Allows explicitly injecting or restoring a pinned rate into memory.

### 2. Distribution Engine Integration (`src/services/distributionEngine.ts`)
- During `distributeWithBatch`:
  1. Calls `fxConversionEngine.freezeRate` with context `${offeringId}-${period.id}` before creating/processing the run.
  2. Emits an `fx.rate.frozen` security/audit log event with rate metadata (pair, mid rate, bid rate, ask rate, timestamp, frozen_fx_rate_id).
  3. Saves `frozen_fx_rate_id` on the `distributions` table record.
  4. Pass `frozen_fx_rate_id` to every generated `distribution_payouts` record.
  5. Retries of failed runs reuse the identical pinned rate (`run.frozen_fx_rate_id` or context-cached rate), ensuring rate stability.

### 3. Database Persistence
- `distributions.frozen_fx_rate_id VARCHAR(255)` (indexed via `idx_distributions_frozen_fx_rate`).
- `distribution_payouts.frozen_fx_rate_id VARCHAR(255)` (indexed via `idx_distribution_payouts_frozen_fx_rate`).

## Security & Verification
- High test coverage with edge case testing for idempotency, retry handling, audit log generation, and database mapping.
- Audit event `fx.rate.frozen` emitted whenever a rate freeze window is established.
