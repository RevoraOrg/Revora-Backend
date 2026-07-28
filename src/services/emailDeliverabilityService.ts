import { MetricsCollector } from '../lib/metrics';
import { EmailDeliverabilityRepository } from '../db/repositories/emailDeliverabilityRepository';
import type { BounceEventInput, DomainDeliverability } from '../db/repositories/emailDeliverabilityRepository';

/**
 * Configuration for the EmailDeliverabilityService.
 */
export interface EmailDeliverabilityConfig {
  /** Enable deliverability tracking (default: true). */
  enabled?: boolean;
  /** Number of days before a suppression auto-expires (default: 365). */
  suppressionAutoExpireDays?: number;
  /** Bounce ratio threshold above which an alarm should be raised (default: 0.05 = 5%). */
  bounceRatioAlarmThreshold?: number;
  /** Hours between alignment-failure alarm re-emissions (default: 24). */
  alarmCooldownHours?: number;
}

const DEFAULT_CONFIG: Required<EmailDeliverabilityConfig> = {
  enabled: true,
  suppressionAutoExpireDays: 365,
  bounceRatioAlarmThreshold: 0.05,
  alarmCooldownHours: 24,
};

/**
 * EmailDeliverabilityService
 *
 * Tracks per-domain sending reputation (DKIM/DMARC/SPF alignment),
 * manages bounce/complaint suppression lists, and emits Prometheus-style
 * metrics for monitoring and alerting.
 *
 * Security assumptions:
 * - Bounce-event payloads are stripped of PII before being passed to the
 *   repository (this service never logs raw payloads).
 * - Suppressions auto-expire to prevent permanent denial of legitimate email.
 * - Alignment alarms are rate-limited (cooldown) to avoid alert fatigue.
 */
export class EmailDeliverabilityService {
  private readonly repo: EmailDeliverabilityRepository;
  private readonly metrics: MetricsCollector;
  private readonly config: Required<EmailDeliverabilityConfig>;

  constructor(
    repo: EmailDeliverabilityService['repo'],
    metrics: EmailDeliverabilityService['metrics'],
    config: EmailDeliverabilityConfig = {},
  ) {
    this.repo = repo;
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a successfully sent email.
   * Updates the per-domain sent counter and emits a counter metric.
   */
  async recordSend(email: string, domain: string, provider: string): Promise<void> {
    if (!this.config.enabled) return;

    await this.repo.upsertDomain(domain, provider);
    await this.repo.recordSend(domain);

    this.metrics.incrementCounter(
      'email_sent_total',
      { domain, provider },
      1,
      'Total transactional emails sent, by domain and provider',
    );
  }

  /**
   * Record a bounce event.
   * Inserts the bounce event, updates domain counters, optionally
   * auto-suppresses the recipient, and emits metrics.
   */
  async recordBounce(
    input: BounceEventInput & {
      /** Whether to auto-suppress the recipient. */
      autoSuppress?: boolean;
    },
  ): Promise<void> {
    if (!this.config.enabled) return;

    // 1. Insert the bounce event (deduplicated by provider_event_id)
    const event = await this.repo.insertBounceEvent(input);

    // 2. Update domain counter
    const isBlock = input.bounce_type === 'block';
    const isComplaint = input.bounce_type === 'spam_complaint';
    if (isBlock) {
      await this.repo.recordBlock(input.domain);
    } else if (isComplaint) {
      await this.repo.recordComplaint(input.domain);
    } else {
      await this.repo.recordBounce(input.domain);
    }

    // 3. Auto-suppress hard bounces and complaints (soft bounces are transient)
    if (input.autoSuppress !== false && (input.bounce_type === 'hard_bounce' || input.bounce_type === 'spam_complaint')) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + this.config.suppressionAutoExpireDays);
      await this.repo.addSuppression({
        email: input.email,
        reason: input.bounce_type === 'hard_bounce' ? 'hard_bounce' : 'spam_complaint',
        bounce_event_id: event?.id ?? undefined,
        expires_at: expiresAt,
      });
    }

    // 4. Emit metrics
    this.metrics.incrementCounter(
      'email_bounce_total',
      { domain: input.domain, provider: input.provider, bounce_type: input.bounce_type },
      1,
      'Total email bounces, by domain, provider, and type',
    );

    // Emit the bounce_ratio gauge per domain
    await this.emitBounceRatioGauge(input.domain);
  }

  /**
   * Record DKIM/DMARC/SPF alignment check result for a domain.
   */
  async recordAlignmentResult(
    domain: string,
    provider: string,
    alignment: {
      dkim_status?: string;
      spf_status?: string;
      dmarc_status?: string;
      dmarc_policy?: string;
      aligned: boolean;
    },
  ): Promise<void> {
    if (!this.config.enabled) return;

    await this.repo.upsertDomain(domain, provider, alignment);

    this.metrics.setGauge(
      'email_alignment_status',
      alignment.aligned ? 1 : 0,
      { domain, check: 'dkim_dmarc_spf' },
      'DKIM/DMARC/SPF alignment status per domain (1=aligned, 0=failed)',
    );

    if (!alignment.aligned) {
      this.metrics.incrementCounter(
        'email_alignment_failure_total',
        { domain },
        1,
        'Total alignment failures per domain',
      );
    }
  }

  /**
   * Check if an email address is currently suppressed.
   */
  async isSuppressed(email: string): Promise<boolean> {
    if (!this.config.enabled) return false;
    return this.repo.isSuppressed(email);
  }

  /**
   * Manually add a suppression for an email address.
   */
  async addSuppression(
    email: string,
    reason: 'hard_bounce' | 'soft_bounce' | 'spam_complaint' | 'block' | 'manual',
    expiresAt?: Date,
  ): Promise<void> {
    if (!this.config.enabled) return;
    await this.repo.addSuppression({ email, reason, expires_at: expiresAt });
  }

  /**
   * Remove all suppressions for an email address (manual override).
   */
  async removeSuppression(email: string): Promise<void> {
    if (!this.config.enabled) return;
    await this.repo.removeSuppression(email);
  }

  /**
   * Get the current bounce ratio for a domain.
   */
  async getBounceRatio(domain: string): Promise<number> {
    const record = await this.repo.findByDomain(domain);
    return record?.bounce_ratio ?? 0;
  }

  /**
   * Get full domain deliverability metrics.
   */
  async getDomainMetrics(domain: string): Promise<DomainDeliverability | null> {
    return this.repo.findByDomain(domain);
  }

  /**
   * Check for domains with alignment failures that need alarms.
   * Emits alarm metrics and marks them as raised (cooldown).
   *
   * Returns the list of domains that triggered an alarm.
   */
  async checkAlignmentAlarms(): Promise<DomainDeliverability[]> {
    if (!this.config.enabled) return [];

    const failures = await this.repo.listAlignmentFailures(this.config.alarmCooldownHours);

    for (const d of failures) {
      this.metrics.incrementCounter(
        'email_alarm_alignment_failure',
        { domain: d.domain },
        1,
        'Alarm raised for email alignment failure',
      );
      await this.repo.markAlarmRaised(d.domain);
    }

    return failures;
  }

  /**
   * Check for domains with high bounce ratios that need alarms.
   *
   * Returns the list of domains that exceed the threshold.
   */
  async checkHighBounceRatioAlarms(): Promise<DomainDeliverability[]> {
    if (!this.config.enabled) return [];

    const highBounce = await this.repo.listHighBounceRatioDomains(this.config.bounceRatioAlarmThreshold);

    for (const d of highBounce) {
      this.metrics.incrementCounter(
        'email_alarm_high_bounce_ratio',
        { domain: d.domain, ratio: String(d.bounce_ratio.toFixed(4)) },
        1,
        'Alarm raised for high bounce ratio',
      );
    }

    return highBounce;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Emit the bounce_ratio gauge for a domain.
   */
  private async emitBounceRatioGauge(domain: string): Promise<void> {
    const record = await this.repo.findByDomain(domain);
    if (record) {
      this.metrics.setGauge(
        'email_bounce_ratio',
        record.bounce_ratio,
        { domain },
        'Bounce ratio per domain (bounces / sent)',
      );
    }
  }
}

