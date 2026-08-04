/**
 * FX Quorum runtime bootstrap (#704).
 *
 * Constructs an `FxProviderRouter` in quorum mode with paging + audit so
 * production no longer silently falls back to first-healthy-wins.
 */

import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import { SecurityAuditRepository } from '../security/types';
import { RateProvider } from './fxConversionEngine';
import {
  FxQuorumAlerting,
  FxQuorumAssessment,
  FxQuorumConfig,
  FxQuorumEvaluator,
  FxQuorumPageSink,
} from './fxQuorumEvaluator';
import { DEFAULT_FX_QUORUM_CONFIG } from './tenantSettingsService';
import {
  FxProviderRouter,
  ProviderHealthScorer,
  ScoredRateProvider,
} from './providerHealthScorer';

export interface FxQuorumBootstrapOptions {
  /** Upstream rate providers (declaration order = priority). */
  providers: Array<{ id: string; provider: RateProvider }>;
  /** Quorum knobs; defaults to platform defaults (k=2, tolerance=0.5%). */
  quorum?: Partial<FxQuorumConfig>;
  metrics?: MetricsCollector;
  logger?: Logger;
  auditRepo?: SecurityAuditRepository;
  /**
   * Optional pager sink. When omitted, failures are still logged + counted;
   * operators should wire PagerDuty here in production.
   */
  pager?: FxQuorumPageSink;
  /** Tenant id used for audit annotations (optional). */
  tenantId?: string;
  actorId?: string;
}

export interface FxQuorumBootstrapResult {
  router: FxProviderRouter;
  scorer: ProviderHealthScorer;
  evaluator: FxQuorumEvaluator;
  alerting: FxQuorumAlerting;
}

/**
 * Build a quorum-enforcing FX router ready for `FxConversionEngine`.
 *
 * @throws if fewer than one provider is supplied, or if k > n.
 */
export function bootstrapFxQuorumRouter(
  options: FxQuorumBootstrapOptions
): FxQuorumBootstrapResult {
  if (!options.providers.length) {
    throw new Error('bootstrapFxQuorumRouter: at least one provider is required');
  }

  const logger = options.logger ?? globalLogger;
  const metrics = options.metrics;
  const scorer = new ProviderHealthScorer({}, metrics, logger);

  const scored = options.providers.map(
    ({ id, provider }) => new ScoredRateProvider(id, provider, scorer)
  );

  const quorumConfig: FxQuorumConfig = {
    ...DEFAULT_FX_QUORUM_CONFIG,
    ...options.quorum,
  };

  const defaultPager: FxQuorumPageSink = (failure: FxQuorumAssessment) => {
    logger.error('fx.quorum.failed — paging ops', {
      alert: 'fx_quorum_failed_total',
      pair: failure.pair,
      k: failure.k,
      valid: failure.valid,
      inConsensus: failure.inConsensus,
      divergent: failure.divergent,
      runbook: 'docs/fx-quorum-variance-guard.md',
    });
  };

  const alerting = new FxQuorumAlerting(
    options.pager ?? defaultPager,
    options.auditRepo,
    { tenantId: options.tenantId, actorId: options.actorId }
  );

  const evaluator = new FxQuorumEvaluator(quorumConfig, {
    metrics,
    logger,
    pager: (failure) => alerting.handle(failure),
  });

  const router = new FxProviderRouter(scored, scorer, evaluator);

  logger.info('FX quorum router bootstrapped', {
    providerCount: scored.length,
    k: quorumConfig.k,
    tolerance: quorumConfig.tolerance,
    reference: quorumConfig.reference ?? 'median',
  });

  return { router, scorer, evaluator, alerting };
}
