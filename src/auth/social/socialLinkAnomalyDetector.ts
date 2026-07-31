/**
 * @file socialLinkAnomalyDetector.ts
 *
 * @notice Detects suspicious social account-linking patterns and feeds the AML
 *         workflow.
 *
 * @dev The attack this defends against is "social identity spraying": an
 *      attacker who obtains a Google/Apple ID token (or who is able to produce
 *      one for a victim's `sub`) tries to link that same social identity to
 *      many *different* Revora accounts.  Each attempt requires step-up
 *      (current password), so the spray manifests as a burst of failed link
 *      attempts across many candidate accounts.
 *
 *      The detector counts DISTINCT candidate accounts per
 *      `(provider, provider_subject)` within a sliding window.  When the count
 *      reaches `threshold` (default 5 distinct accounts in 24h) it:
 *
 *        1. Emits a `social_link_anomaly_total` counter metric.
 *        2. Logs a high-severity ALARM.
 *        3. Records a `social_link_anomaly_detected` security audit event
 *           (type SECURITY_VIOLATION, outcome BLOCKED).
 *        4. Feeds the AML sink so compliance analysts can open a case.
 *
 *      A cooldown (default 1h) suppresses repeat alerts for the same identity
 *      so a sustained attack alerts periodically rather than on every attempt.
 *
 * Security assumptions:
 * - The provider subject is only trusted after `SocialTokenVerifier` validates
 *   the ID token (RS256 + JWKS).  The detector itself never parses raw tokens.
 * - Alerts must not leak the raw ID token or provider email into logs/metrics;
 *   only provider + subject + candidate user IDs are emitted.
 * - Detector failures must never break the link flow: all alert-side I/O is
 *   wrapped so a sink/audit failure cannot abort an otherwise valid link.
 */

import { Logger, globalLogger } from '../../lib/logger';
import { MetricsCollector, globalMetrics } from '../../lib/metrics';
import { SecurityAuditRepository } from '../../security/types';
import { SocialAuthProvider } from './types';
import {
  InMemorySocialLinkAttemptStore,
  SocialLinkAttempt,
  SocialLinkAttemptStore,
} from './socialLinkAttemptStore';

// ─── Constants ───────────────────────────────────────────────────────────────

const METRIC_ANOMALY = 'social_link_anomaly_total';
const AUDIT_ACTION_ANOMALY = 'social_link_anomaly_detected';
const AUDIT_RESOURCE_PREFIX = 'social-identity';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Result of a single attempt evaluation.
 */
export interface SocialLinkAnomalyDetection {
  provider: SocialAuthProvider;
  providerSubject: string;
  /** Distinct candidate accounts observed in the window. */
  candidateUserIds: string[];
  candidateCount: number;
  threshold: number;
  windowMs: number;
  detectedAt: Date;
}

/**
 * Sink that receives confirmed anomalies.  A production implementation should
 * create an AML alert / compliance case; the default implementation records a
 * SECURITY_VIOLATION audit event so the signal is preserved even when no AML
 * integration is configured.
 */
export interface SocialLinkAnomalyAmlSink {
  emit(detection: SocialLinkAnomalyDetection): Promise<void>;
}

export interface SocialLinkAnomalyDetectorOptions {
  /**
   * Distinct candidate accounts that trigger the anomaly within `windowMs`.
   * @default 5
   */
  threshold?: number;
  /**
   * Sliding window over which distinct candidates are counted.
   * @default 24h
   */
  windowMs?: number;
  /**
   * Minimum gap between alerts for the same identity.
   * @default 1h
   */
  cooldownMs?: number;
  /** Attempt store.  Defaults to an in-memory store. */
  store?: SocialLinkAttemptStore;
  /** Metrics collector.  Defaults to `globalMetrics`. */
  metrics?: MetricsCollector;
  /** Logger.  Defaults to `globalLogger`. */
  logger?: Logger;
  /** Security audit repository for anomaly events. */
  auditRepository?: SecurityAuditRepository;
  /** AML sink fed on detection.  Defaults to a security-audit sink. */
  amlSink?: SocialLinkAnomalyAmlSink;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

// ─── Default AML sink ────────────────────────────────────────────────────────

/**
 * Default AML sink: records the anomaly as a SECURITY_VIOLATION audit event.
 * Production deployments can supply a sink that creates an `aml_alerts` row or
 * opens a compliance case.
 */
export class AuditLogAmlSink implements SocialLinkAnomalyAmlSink {
  constructor(
    private readonly auditRepository: SecurityAuditRepository,
    private readonly logger: Logger = globalLogger,
  ) {}

  async emit(detection: SocialLinkAnomalyDetection): Promise<void> {
    await this.auditRepository.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'SECURITY_VIOLATION',
      // Anchor the event to the first candidate account; the full candidate set
      // is preserved in details for the analyst.
      userId: detection.candidateUserIds[0],
      action: AUDIT_ACTION_ANOMALY,
      resource: `${AUDIT_RESOURCE_PREFIX}/${detection.provider}/${detection.providerSubject}`,
      outcome: 'BLOCKED',
      details: {
        provider: detection.provider,
        providerSubject: detection.providerSubject,
        candidateUserIds: detection.candidateUserIds,
        candidateCount: detection.candidateCount,
        threshold: detection.threshold,
        windowMs: detection.windowMs,
      },
      securityContext: {
        requestId: `social-link-anomaly-${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'social-link-anomaly-detector',
        timestamp: detection.detectedAt,
      },
      timestamp: detection.detectedAt,
    });
  }
}

// ─── Detector ────────────────────────────────────────────────────────────────

export class SocialLinkAnomalyDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly store: SocialLinkAttemptStore;
  private readonly metrics?: MetricsCollector;
  private readonly logger: Logger;
  private readonly auditRepository?: SecurityAuditRepository;
  private readonly amlSink?: SocialLinkAnomalyAmlSink;
  private readonly now: () => Date;

  /** Last alert timestamp per `provider:subject` key (ms since epoch). */
  private readonly lastAlertedAt = new Map<string, number>();

  constructor(options: SocialLinkAnomalyDetectorOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
    this.cooldownMs = options.cooldownMs ?? 60 * 60 * 1000;
    this.store = options.store ?? new InMemorySocialLinkAttemptStore();
    this.metrics = options.metrics ?? globalMetrics;
    this.logger = options.logger ?? globalLogger;
    this.auditRepository = options.auditRepository;
    this.amlSink = options.amlSink;
    this.now = options.now ?? (() => new Date());

    if (!Number.isInteger(this.threshold) || this.threshold < 2) {
      throw new Error('SocialLinkAnomalyDetector threshold must be an integer >= 2');
    }
    if (!(this.windowMs > 0)) {
      throw new Error('SocialLinkAnomalyDetector windowMs must be positive');
    }
    if (!(this.cooldownMs >= 0)) {
      throw new Error('SocialLinkAnomalyDetector cooldownMs must be non-negative');
    }
  }

  /**
   * Record a link attempt and evaluate whether the identity is being sprayed
   * across too many candidate accounts.
   *
   * @param attempt The attempt to record.  The `attemptedAt` defaults to now
   *                when omitted.
   * @returns The anomaly detection when the threshold was crossed (and the
   *          cooldown has elapsed), otherwise `null`.
   *
   * @dev The caller is responsible for recording attempts with the VERIFIED
   *      provider subject (i.e. after token verification).
   */
  async recordAttempt(attempt: SocialLinkAttempt): Promise<SocialLinkAnomalyDetection | null> {
    const now = this.now();
    const normalized: SocialLinkAttempt = {
      ...attempt,
      attemptedAt: attempt.attemptedAt ?? now,
    };

    await this.store.recordAttempt(normalized);

    const since = new Date(now.getTime() - this.windowMs);
    const candidates = await this.store.listCandidateUserIds(
      normalized.provider,
      normalized.providerSubject,
      since,
    );

    if (candidates.length < this.threshold) {
      return null;
    }

    const key = this.key(normalized.provider, normalized.providerSubject);
    const lastAlerted = this.lastAlertedAt.get(key) ?? 0;
    if (now.getTime() - lastAlerted < this.cooldownMs) {
      return null;
    }

    this.lastAlertedAt.set(key, now.getTime());

    const detection: SocialLinkAnomalyDetection = {
      provider: normalized.provider,
      providerSubject: normalized.providerSubject,
      candidateUserIds: candidates,
      candidateCount: candidates.length,
      threshold: this.threshold,
      windowMs: this.windowMs,
      detectedAt: now,
    };

    await this.emitDetection(detection);
    return detection;
  }

  /** Number of distinct candidate accounts currently recorded for an identity. */
  async getCandidateCount(
    provider: SocialAuthProvider,
    providerSubject: string,
  ): Promise<number> {
    const since = new Date(this.now().getTime() - this.windowMs);
    return (await this.store.listCandidateUserIds(provider, providerSubject, since)).length;
  }

  /** Reset state (attempts + cooldowns).  Test-only helper. */
  async reset(): Promise<void> {
    this.lastAlertedAt.clear();
    await this.store.reset();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private key(provider: SocialAuthProvider, providerSubject: string): string {
    return `${provider}:${providerSubject}`;
  }

  private async emitDetection(detection: SocialLinkAnomalyDetection): Promise<void> {
    // 1. Metric — aggregate, no PII in labels.
    try {
      this.metrics?.incrementCounter(
        METRIC_ANOMALY,
        { provider: detection.provider },
        1,
        'Number of social account-linking anomaly patterns detected',
      );
    } catch (err) {
      this.logger.warn('Failed to emit social link anomaly metric', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. High-severity alarm log.
    this.logger.error('ALARM: social account-linking anomaly detected', {
      severity: 'high',
      alarm: 'social_link_anomaly',
      provider: detection.provider,
      providerSubject: detection.providerSubject,
      candidateCount: detection.candidateCount,
      threshold: detection.threshold,
      windowMs: detection.windowMs,
    });

    // 3. Security audit event.
    if (this.auditRepository) {
      try {
        await this.auditRepository.record({
          id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          type: 'SECURITY_VIOLATION',
          userId: detection.candidateUserIds[0],
          action: AUDIT_ACTION_ANOMALY,
          resource: `${AUDIT_RESOURCE_PREFIX}/${detection.provider}/${detection.providerSubject}`,
          outcome: 'BLOCKED',
          details: {
            provider: detection.provider,
            providerSubject: detection.providerSubject,
            candidateUserIds: detection.candidateUserIds,
            candidateCount: detection.candidateCount,
            threshold: detection.threshold,
            windowMs: detection.windowMs,
          },
          securityContext: {
            requestId: `social-link-anomaly-${Date.now()}`,
            ipAddress: 'system',
            userAgent: 'social-link-anomaly-detector',
            timestamp: detection.detectedAt,
          },
          timestamp: detection.detectedAt,
        });
      } catch (err) {
        this.logger.warn('Failed to record social link anomaly audit event', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 4. Feed AML.  Failures must never break the link flow.
    if (this.amlSink) {
      try {
        await this.amlSink.emit(detection);
      } catch (err) {
        this.logger.warn('AML sink failed to process social link anomaly', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
