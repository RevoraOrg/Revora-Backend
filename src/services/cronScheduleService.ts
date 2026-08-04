/**
 * CronScheduleService — validates and persists deferred distribution cron windows.
 *
 * @see ../docs/distribution-cron-window-definitions.md
 * @see ./distributionScheduler.ts (CronWindowValidator)
 *
 * Security assumptions:
 * - Cron expressions are untrusted operator input; syntax + Stellar maintenance
 *   + overlap checks run before any persistence.
 * - Overlap diffs are logged (expression only — no secrets/PII).
 */

import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import { Offering, OfferingRepository } from '../db/repositories/offeringRepository';
import {
  CronWindowDefinition,
  CronWindowValidator,
  CronWindowValidationResult,
} from './distributionScheduler';
import { Pool } from 'pg';

export interface PersistCronScheduleInput {
  offeringId: string;
  expression: string;
  timezone?: string;
}

export interface PersistCronScheduleResult {
  offering: Offering;
  validation: CronWindowValidationResult;
}

export class CronScheduleService {
  private readonly validator: CronWindowValidator;
  private readonly logger: Logger;

  constructor(
    private readonly offeringRepo: OfferingRepository,
    private readonly pool: Pool,
    options: { metrics?: MetricsCollector; logger?: Logger; lookaheadDays?: number } = {}
  ) {
    this.logger = options.logger ?? globalLogger;
    this.validator = new CronWindowValidator({
      lookaheadDays: options.lookaheadDays ?? 60,
      metrics: options.metrics,
      logger: this.logger,
    });
  }

  /**
   * Validate `expression` against Stellar maintenance + existing offering windows,
   * then persist to offerings + distribution_schedules. Rejects before write.
   */
  async persistSchedule(input: PersistCronScheduleInput): Promise<PersistCronScheduleResult> {
    const timezone = input.timezone ?? 'UTC';
    const incoming: CronWindowDefinition = {
      offeringId: input.offeringId,
      expression: input.expression,
      timezone,
    };

    const existingOfferings = await this.offeringRepo.listWithCronSchedules();
    const existing: CronWindowDefinition[] = existingOfferings
      .filter((o) => o.id !== input.offeringId && typeof o.cron_expression === 'string')
      .map((o) => ({
        offeringId: o.id,
        expression: String(o.cron_expression),
        timezone: String(o.distribution_timezone ?? o.timezone ?? 'UTC'),
      }));

    const validation = this.validator.validateAgainstExisting(incoming, existing);
    if (!validation.valid) {
      throw Errors.validationError(
        `Cron window rejected: ${validation.reasons.join('; ')}`
      );
    }

    const offering = await this.offeringRepo.updateCronSchedule(
      input.offeringId,
      input.expression,
      timezone
    );
    if (!offering) {
      throw Errors.notFound(`Offering ${input.offeringId} not found`);
    }

    // Upsert into distribution_schedules (issue #661 persistence target).
    await this.pool.query(
      `
        INSERT INTO distribution_schedules (offering_id, cron, timezone, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (offering_id) DO UPDATE
          SET cron = EXCLUDED.cron,
              timezone = EXCLUDED.timezone,
              updated_at = NOW()
      `,
      [input.offeringId, input.expression, timezone]
    );

    this.logger.info('scheduler.window.persisted', {
      offeringId: input.offeringId,
      expression: input.expression,
      timezone,
    });

    return { offering, validation };
  }

  /**
   * Clear a deferred schedule (falls back to fixed-interval processing).
   */
  async clearSchedule(offeringId: string): Promise<Offering | null> {
    const offering = await this.offeringRepo.updateCronSchedule(offeringId, null, 'UTC');
    await this.pool.query(`DELETE FROM distribution_schedules WHERE offering_id = $1`, [
      offeringId,
    ]);
    return offering;
  }
}
