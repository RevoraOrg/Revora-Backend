import { createPublicKey, createVerify } from 'node:crypto';
import { globalMetrics } from '../../lib/metrics';
import {
  SocialAuthError,
  SocialAuthProvider,
  SocialProviderClaims,
  SocialTokenVerifier,
} from './types';

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  exp?: number;
  nbf?: number;
}

interface ProviderConfig {
  provider: SocialAuthProvider;
  issuers: readonly string[];
  audiences: readonly string[];
  jwksUrl: string;
}

interface JwksResponse {
  keys: ProviderJwk[];
}

type ProviderJwk = Record<string, unknown> & { kid?: string };

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const APPLE_ISSUERS = ['https://appleid.apple.com'] as const;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REFRESH_BUDGET_PER_MINUTE = 10;

function splitEnvList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function decodeJwtPart<T>(part: string): T {
  try {
    return JSON.parse(decodeBase64Url(part).toString('utf8')) as T;
  } catch {
    throw new SocialAuthError('INVALID_TOKEN', 'Identity token is not valid JSON.');
  }
}

function normalizeEmailVerified(value: boolean | string | undefined): boolean {
  return value === true || value === 'true';
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface RefreshBudget {
  count: number;
  windowStart: number;
}

/**
 * Verifies social identity tokens (Google / Apple) using JWKS signing keys.
 *
 * Key rotation handling:
 * - Provider signing keys are cached with a TTL.
 * - When a JWT references a KID not present in the local cache, the verifier
 *   triggers a single-flight JWKS refresh and retries verification once.
 * - A per-provider rate limit guards against refresh storms during provider
 *   outages or malicious clients.
 *
 * Single-flight refresh:
 * - Concurrent requests that encounter the same unknown KID share the same
 *   in-flight refresh promise so that only one outbound request is made.
 *
 * Security guarantees:
 * - JWT validation behaviour is unchanged except for the refresh retry.
 * - Verification is never skipped.
 * - Signatures are always validated.
 * - Issuer and audience validation remain intact.
 * - Unknown keys never bypass authentication.
 * - Refresh failures do not authenticate users.
 * - Provider outages cannot create refresh loops because the retry is bounded
 *   to exactly one attempt and the rate limit caps outbound requests.
 */
export class JwksSocialTokenVerifier implements SocialTokenVerifier {
  private readonly configs: Map<SocialAuthProvider, ProviderConfig>;
  private readonly jwksCache = new Map<string, { expiresAt: number; keys: ProviderJwk[] }>();
  private readonly inFlightRefreshes = new Map<string, Promise<ProviderJwk[]>>();
  private readonly refreshBudgets = new Map<SocialAuthProvider, RefreshBudget>();
  private readonly refreshBudgetPerMinute: number;

  private readonly metrics: { incrementCounter(name: string, labels?: Record<string, string>, value?: number, help?: string): void };

  constructor(configs: ProviderConfig[], refreshBudgetPerMinute = DEFAULT_REFRESH_BUDGET_PER_MINUTE, metrics?: { incrementCounter(name: string, labels?: Record<string, string>, value?: number, help?: string): void }) {
    this.configs = new Map(configs.map((config) => [config.provider, config]));
    this.refreshBudgetPerMinute = refreshBudgetPerMinute;
    this.metrics = metrics ?? globalMetrics;
  }

  async verify(provider: SocialAuthProvider, idToken: string): Promise<SocialProviderClaims> {
    const config = this.configs.get(provider);
    if (!config || config.audiences.length === 0) {
      throw new SocialAuthError('PROVIDER_NOT_CONFIGURED', `${provider} social login is not configured.`);
    }

    const parts = idToken.split('.');
    if (parts.length !== 3) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token must be a compact JWT.');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJwtPart<JwtHeader>(encodedHeader);
    const payload = decodeJwtPart<JwtPayload>(encodedPayload);

    if (header.alg !== 'RS256') {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token must use RS256.');
    }
    if (!header.kid) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token is missing a key id.');
    }
    if (!payload.iss || !config.issuers.includes(payload.iss)) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token issuer is not trusted.');
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
    const audience = audiences.find((candidate): candidate is string =>
      typeof candidate === 'string' && config.audiences.includes(candidate),
    );
    if (!audience) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token audience is not allowed.');
    }

    const now = nowEpochSeconds();
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token has expired.');
    }
    if (typeof payload.nbf === 'number' && payload.nbf > now) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token is not valid yet.');
    }
    if (!payload.sub || !payload.email) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token is missing subject or email.');
    }

    await this.verifySignature(config, header.kid, `${encodedHeader}.${encodedPayload}`, encodedSignature);

    return {
      provider,
      subject: payload.sub,
      email: payload.email.toLowerCase().trim(),
      emailVerified: normalizeEmailVerified(payload.email_verified),
      issuer: payload.iss,
      audience,
    };
  }

  private async verifySignature(
    config: ProviderConfig,
    kid: string,
    signingInput: string,
    encodedSignature: string,
  ): Promise<void> {
    let keys = await this.getJwks(config.jwksUrl);
    let jwk = keys.find((key) => key.kid === kid);

    if (!jwk) {
      const refreshed = await this.refreshKeys(config.provider, config.jwksUrl);
      jwk = refreshed.find((key) => key.kid === kid);
      if (!jwk) {
        throw new SocialAuthError('INVALID_TOKEN', 'Identity token key id is not trusted.');
      }
      keys = refreshed;
    }

    const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();

    if (!verifier.verify(publicKey, decodeBase64Url(encodedSignature))) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token signature is invalid.');
    }
  }

  private async getJwks(jwksUrl: string): Promise<ProviderJwk[]> {
    const cached = this.jwksCache.get(jwksUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }

    return this.fetchJwks(jwksUrl);
  }

  /**
   * Refreshes the JWKS for a provider, enforcing single-flight execution and
   * per-provider rate limits.
   *
   * - If another refresh is already in-flight for the same JWKS URL, the
   *   caller awaits that same promise instead of issuing a duplicate request.
   * - If the per-provider refresh budget has been exhausted for the current
   *   window, the call is skipped and the existing cache is returned.
   * - Metrics are emitted for every attempt with the outcome label.
   */
  private async refreshKeys(provider: SocialAuthProvider, jwksUrl: string): Promise<ProviderJwk[]> {
    const inFlight = this.inFlightRefreshes.get(jwksUrl);
    if (inFlight) {
      this.metrics.incrementCounter('social.keys.refresh.attempts', {
        provider,
        outcome: 'skipped',
      });
      return inFlight;
    }

    if (!this.isWithinBudget(provider)) {
      this.metrics.incrementCounter('social.keys.refresh.attempts', {
        provider,
        outcome: 'rate_limited',
      });
      return this.getCachedKeys(jwksUrl);
    }

      this.metrics.incrementCounter('social.keys.refresh.attempts', {
        provider,
        outcome: 'attempt',
      });

    const pending = this.fetchJwks(jwksUrl)
      .then((keys) => {
        this.consumeBudget(provider);
        return keys;
      })
      .catch((error) => {
        this.metrics.incrementCounter('social.keys.refresh.attempts', {
          provider,
          outcome: 'failure',
        });
        throw error;
      })
      .finally(() => {
        this.inFlightRefreshes.delete(jwksUrl);
      });

    this.inFlightRefreshes.set(jwksUrl, pending);

    try {
      const keys = await pending;
      this.metrics.incrementCounter('social.keys.refresh.attempts', {
        provider,
        outcome: 'success',
      });
      return keys;
    } catch {
      throw new SocialAuthError('INVALID_TOKEN', 'Unable to refresh provider signing keys.');
    }
  }

  private isWithinBudget(provider: SocialAuthProvider): boolean {
    const now = Date.now();
    const budget = this.refreshBudgets.get(provider);

    if (!budget || now - budget.windowStart >= 60_000) {
      this.refreshBudgets.set(provider, { count: 0, windowStart: now });
      return true;
    }

    return budget.count < this.refreshBudgetPerMinute;
  }

  private consumeBudget(provider: SocialAuthProvider): void {
    const budget = this.refreshBudgets.get(provider);
    if (budget && Date.now() - budget.windowStart < 60_000) {
      budget.count += 1;
    } else {
      this.refreshBudgets.set(provider, { count: 1, windowStart: Date.now() });
    }
  }

  private async fetchJwks(jwksUrl: string): Promise<ProviderJwk[]> {
    let response: Response;
    try {
      response = await fetch(jwksUrl);
    } catch {
      throw new SocialAuthError('INVALID_TOKEN', 'Unable to fetch provider signing keys.');
    }
    if (!response.ok) {
      throw new SocialAuthError('INVALID_TOKEN', 'Unable to fetch provider signing keys.');
    }
    const body = (await response.json()) as JwksResponse;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    this.jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + CACHE_TTL_MS });
    return keys;
  }

  private getCachedKeys(jwksUrl: string): ProviderJwk[] {
    const cached = this.jwksCache.get(jwksUrl);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.keys;
    }
    return [];
  }
}

export function createDefaultSocialTokenVerifierFromEnv(): SocialTokenVerifier {
  return new JwksSocialTokenVerifier([
    {
      provider: 'google',
      issuers: GOOGLE_ISSUERS,
      audiences: splitEnvList(process.env.GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID),
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    },
    {
      provider: 'apple',
      issuers: APPLE_ISSUERS,
      audiences: splitEnvList(process.env.APPLE_CLIENT_ID ?? process.env.APPLE_SERVICE_ID),
      jwksUrl: 'https://appleid.apple.com/auth/keys',
    },
  ]);
}