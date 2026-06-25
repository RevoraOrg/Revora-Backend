import { createPublicKey, createVerify } from 'node:crypto';
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

export class JwksSocialTokenVerifier implements SocialTokenVerifier {
  private readonly configs: Map<SocialAuthProvider, ProviderConfig>;
  private readonly jwksCache = new Map<string, { expiresAt: number; keys: ProviderJwk[] }>();

  constructor(configs: ProviderConfig[]) {
    this.configs = new Map(configs.map((config) => [config.provider, config]));
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
    const keys = await this.getJwks(config.jwksUrl);
    const jwk = keys.find((key) => key.kid === kid);
    if (!jwk) {
      throw new SocialAuthError('INVALID_TOKEN', 'Identity token key id is not trusted.');
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

    const response = await fetch(jwksUrl);
    if (!response.ok) {
      throw new SocialAuthError('INVALID_TOKEN', 'Unable to fetch provider signing keys.');
    }

    const body = (await response.json()) as JwksResponse;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    this.jwksCache.set(jwksUrl, { keys, expiresAt: Date.now() + CACHE_TTL_MS });
    return keys;
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
