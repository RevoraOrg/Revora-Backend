/**
 * KYC/AML Provider Adapter
 *
 * Provider-agnostic adapter surface on top of a raw {@link KycProvider}. It
 * adds the production-grade behaviours required by the KYC/AML integration:
 *
 *  - **Retry**: provider calls (initiate/getStatus) are retried with
 *    exponential backoff so transient vendor outages do not fail an investor's
 *    onboarding outright. This is deliberately bounded (maxRetries) and
 *    documented so failures eventually surface to ops instead of looping.
 *  - **Feature-flagged selection**: the {@link createKycProviderAdapter}
 *    factory returns the hardened {@link DefaultKycProviderAdapter} only when
 *    `KYC_PROVIDER_ADAPTER_ENABLED` is truthy. Otherwise it returns
 *    {@link PassthroughKycProviderAdapter}, which delegates straight to the
 *    legacy provider and preserves pre-adapter behaviour exactly (compat).
 *
 * Security assumptions:
 * - Webhook callbacks are signature-verified and replay-protected at the HTTP
 *   layer (see `kycWebhookAuth` + the replay guard used by the verification
 *   service) before this adapter's result is trusted.
 * - Retry never caches decisions; statuses only change through verified
 *   provider callbacks or explicit getStatus polls.
 */

import { KycProvider, KycApplicantInfo, KycCheckResult } from './KycProvider';
import { globalMetrics } from '../../lib/metrics';
import { Errors } from '../../lib/errors';

export interface KycProviderAdapterConfig {
  /** When false the adapter delegates without retry/hardening (legacy). */
  enabled: boolean;
  /** Maximum number of attempts (including the first) for provider calls. */
  maxRetries?: number;
  /** Base delay for exponential backoff between attempts (ms). */
  baseRetryDelayMs?: number;
}

export const DEFAULT_KYC_ADAPTER_CONFIG: Readonly<Required<KycProviderAdapterConfig>> = {
  enabled: false,
  maxRetries: 3,
  baseRetryDelayMs: 250,
};

/**
 * Contract implemented by every KYC provider adapter.
 *
 * `initiateCheck` starts a provider check for an applicant; `getStatus`
 * actively polls a running check. Both are retried on transient failure per
 * the adapter's configuration. `handleWebhook` delegates to the underlying
 * provider (signature verification happens at the route layer).
 */
export interface KycProviderAdapter extends KycProvider {
  readonly name: string;
  /** Feature-flag state — `false` for the legacy passthrough. */
  readonly enabled: boolean;
  /** Name of the underlying provider (for logging/telemetry). */
  readonly providerName: string;
}

/**
 * Retries an async provider call with exponential backoff.
 *
 * @param fn         The provider operation.
 * @param operation  Operation label for logging/telemetry.
 * @param maxRetries Total attempts (>= 1).
 * @param baseDelayMs Base backoff delay; every attempt multiplies by 2^(n-1).
 * @param sleep      Injectable sleep for deterministic tests.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  maxRetries: number,
  baseDelayMs: number,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      globalMetrics.incrementCounter('kyc.adapter.retry_failure', {
        operation,
        attempt: String(attempt),
      });
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hardened adapter selected behind the `KYC_PROVIDER_ADAPTER_ENABLED` flag.
 * Wraps a raw {@link KycProvider} and adds bounded retry with backoff to
 * initiate/getStatus calls.
 */
export class DefaultKycProviderAdapter implements KycProviderAdapter {
  readonly name: string;
  readonly enabled: boolean;
  readonly providerName: string;

  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;

  constructor(
    private readonly inner: KycProvider,
    config: KycProviderAdapterConfig,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    const merged = { ...DEFAULT_KYC_ADAPTER_CONFIG, ...config };
    this.enabled = merged.enabled;
    this.maxRetries = merged.maxRetries;
    this.baseRetryDelayMs = merged.baseRetryDelayMs;
    this.providerName = inner.name;
    this.name = `adapter_${inner.name}`;
  }

  initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult> {
    return withRetry(
      () => this.inner.initiateCheck(investorId, info),
      'initiate_check',
      this.maxRetries,
      this.baseRetryDelayMs,
      this.sleep,
    );
  }

  getStatus(referenceId: string): Promise<KycCheckResult> {
    return withRetry(
      () => this.inner.getStatus(referenceId),
      'get_status',
      this.maxRetries,
      this.baseRetryDelayMs,
      this.sleep,
    );
  }

  handleWebhook(payload: unknown, signature: string): Promise<KycCheckResult> {
    return this.inner.handleWebhook(payload, signature);
  }
}

/**
 * Legacy-compatible adapter returned when the feature flag is off. It
 * delegates directly to the underlying provider with no retry, no audit, and
 * no status mutation — byte-for-byte the pre-adapter behaviour.
 */
export class PassthroughKycProviderAdapter implements KycProviderAdapter {
  readonly enabled = false;
  readonly providerName: string;

  constructor(private readonly inner: KycProvider) {
    this.providerName = inner.name;
  }

  get name(): string {
    return this.inner.name;
  }

  initiateCheck(investorId: string, info: KycApplicantInfo): Promise<KycCheckResult> {
    return this.inner.initiateCheck(investorId, info);
  }

  getStatus(referenceId: string): Promise<KycCheckResult> {
    return this.inner.getStatus(referenceId);
  }

  handleWebhook(payload: unknown, signature: string): Promise<KycCheckResult> {
    return this.inner.handleWebhook(payload, signature);
  }
}

/**
 * Factory that selects the adapter impl behind the feature flag.
 *
 * @param inner  Raw provider to wrap.
 * @param config Adapter configuration; `enabled` selects hardened vs passthrough.
 */
export function createKycProviderAdapter(
  inner: KycProvider,
  config: KycProviderAdapterConfig,
): KycProviderAdapter {
  if (config.enabled) {
    return new DefaultKycProviderAdapter(inner, config);
  }
  return new PassthroughKycProviderAdapter(inner);
}

/** Convenience error for the investment gate when KYC is not approved. */
export function kycNotApprovedError(): Error {
  return Errors.forbidden(
    'Investment blocked: investor KYC/AML verification has not been approved (KYC_NOT_APPROVED).',
  );
}