import { createHash, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import {
  ALLOWED_ID_TOKEN_ALGORITHMS,
  BLOCKED_ID_TOKEN_ALGORITHMS,
  OidcDiscoveryDocument,
  OidcFlowState,
  OidcIdTokenClaims,
  OidcProviderRow,
  OidcTokenResponse,
} from './types';
import { JwksCacheService } from './jwksCache';

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLOCK_SKEW_SECONDS = 300;           // 5 minutes
const STATE_TTL_MS = 10 * 60 * 1000;     // 10 minutes

export class OidcAdapterService {
  private readonly discoveryCache = new Map<string, OidcDiscoveryDocument>();
  private readonly flowStates = new Map<string, OidcFlowState>();
  private readonly consumedJtis = new Map<string, number>();

  constructor(private readonly jwksCache: JwksCacheService) {}

  // ── Discovery ─────────────────────────────────────────────────────────

  async getDiscovery(issuerUrl: string): Promise<OidcDiscoveryDocument> {
    const cached = this.discoveryCache.get(issuerUrl);
    if (cached?._cachedUntil && Date.now() < cached._cachedUntil) return cached;

    const url = `${issuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OIDC discovery failed for ${issuerUrl}: ${res.status}`);

    const doc = (await res.json()) as OidcDiscoveryDocument;
    this.validateDiscovery(doc, issuerUrl);
    doc._cachedUntil = Date.now() + DISCOVERY_TTL_MS;
    this.discoveryCache.set(issuerUrl, doc);
    return doc;
  }

  private validateDiscovery(doc: OidcDiscoveryDocument, expectedIssuer: string): void {
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error('OIDC discovery document missing required fields');
    }
    const normalised = expectedIssuer.replace(/\/$/, '');
    if (doc.issuer !== normalised && doc.issuer !== expectedIssuer) {
      throw new Error(`OIDC issuer mismatch: expected "${expectedIssuer}", got "${doc.issuer}"`);
    }
  }

  // ── PKCE helpers ──────────────────────────────────────────────────────

  generateCodeVerifier(): string {
    return randomBytes(32).toString('base64url');
  }

  codeChallenge(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
  }

  // ── Authorization URL ─────────────────────────────────────────────────

  async buildAuthorizeUrl(provider: OidcProviderRow): Promise<{ url: string; state: string }> {
    const discovery = await this.getDiscovery(provider.issuer_url);
    const codeVerifier = this.generateCodeVerifier();
    const nonce = randomBytes(16).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const redirectUri = provider.redirect_uris.split(',')[0].trim();

    this.flowStates.set(state, {
      tenantId: provider.tenant_id,
      codeVerifier,
      nonce,
      redirectUri,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.client_id,
      redirect_uri: redirectUri,
      scope: provider.scopes,
      state,
      nonce,
      code_challenge: this.codeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });

    return { url: `${discovery.authorization_endpoint}?${params}`, state };
  }

  // ── Callback / token exchange ─────────────────────────────────────────

  async handleCallback(
    code: string,
    stateToken: string,
    provider: OidcProviderRow,
  ): Promise<OidcIdTokenClaims> {
    const flowState = this.consumeFlowState(stateToken);
    if (flowState.tenantId !== provider.tenant_id) throw new Error('State tenant mismatch');

    const discovery = await this.getDiscovery(provider.issuer_url);
    const tokens = await this.exchangeCode(code, flowState, provider, discovery);
    return this.validateIdToken(tokens.id_token, provider, discovery, flowState.nonce);
  }

  consumeFlowState(state: string): OidcFlowState {
    const s = this.flowStates.get(state);
    if (!s) throw new Error('Invalid or unknown OIDC state parameter');
    this.flowStates.delete(state);
    if (Date.now() > s.expiresAt) throw new Error('OIDC flow state expired');
    return s;
  }

  private async exchangeCode(
    code: string,
    flowState: OidcFlowState,
    provider: OidcProviderRow,
    discovery: OidcDiscoveryDocument,
  ): Promise<OidcTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flowState.redirectUri,
      client_id: provider.client_id,
      code_verifier: flowState.codeVerifier,
      ...(provider.client_secret ? { client_secret: provider.client_secret } : {}),
    });

    const res = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token exchange failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<OidcTokenResponse>;
  }

  async refreshJwks(issuerUrl: string): Promise<void> {
    const discovery = await this.getDiscovery(issuerUrl);
    await this.jwksCache.refresh(discovery.jwks_uri, issuerUrl);
  }

  // ── ID Token validation ───────────────────────────────────────────────

  async validateIdToken(
    idToken: string,
    provider: OidcProviderRow,
    discovery: OidcDiscoveryDocument,
    expectedNonce: string,
  ): Promise<OidcIdTokenClaims> {
    // Decode header to extract alg + kid (no verification yet)
    let header: { alg?: string; kid?: string };
    try {
      const [h] = idToken.split('.');
      header = JSON.parse(Buffer.from(h, 'base64url').toString());
    } catch {
      throw new Error('Malformed ID token header');
    }

    if (!header.alg) throw new Error('ID token missing alg header');
    if ((BLOCKED_ID_TOKEN_ALGORITHMS as readonly string[]).includes(header.alg)) {
      throw new Error(`Insecure algorithm rejected: ${header.alg}`);
    }
    if (!(ALLOWED_ID_TOKEN_ALGORITHMS as readonly string[]).includes(header.alg)) {
      throw new Error(`Unknown or disallowed algorithm: ${header.alg}`);
    }
    if (!header.kid) throw new Error('ID token missing kid header');

    let publicKey = await this.jwksCache.getKey(discovery.jwks_uri, header.kid, provider.issuer_url);

    const verifyOpts: jwt.VerifyOptions = {
      algorithms: [...ALLOWED_ID_TOKEN_ALGORITHMS] as jwt.Algorithm[],
      issuer: provider.issuer_url,
      audience: provider.client_id,
      clockTolerance: CLOCK_SKEW_SECONDS,
    };

    let claims: OidcIdTokenClaims;
    try {
      claims = jwt.verify(idToken, publicKey as unknown as string, verifyOpts) as OidcIdTokenClaims;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid signature') || msg.includes('unable to verify')) {
        // Signature failure — rotate JWKS and retry once
        this.jwksCache.evict(discovery.jwks_uri);
        publicKey = await this.jwksCache.getKey(discovery.jwks_uri, header.kid, provider.issuer_url);
        try {
          claims = jwt.verify(idToken, publicKey as unknown as string, verifyOpts) as OidcIdTokenClaims;
        } catch {
          throw new Error('ID token signature invalid after JWKS rotation');
        }
      } else {
        throw new Error(`ID token validation failed: ${msg}`);
      }
    }

    if (claims.nonce !== expectedNonce) throw new Error('ID token nonce mismatch');
    return claims;
  }

  async validateLogoutToken(
    logoutToken: string,
    provider: OidcProviderRow,
    discovery: OidcDiscoveryDocument,
  ): Promise<OidcIdTokenClaims> {
    let header: { alg?: string; kid?: string };
    try {
      const [h] = logoutToken.split('.');
      header = JSON.parse(Buffer.from(h, 'base64url').toString());
    } catch {
      throw new Error('Malformed logout token header');
    }

    if (!header.alg) throw new Error('Logout token missing alg header');
    if ((BLOCKED_ID_TOKEN_ALGORITHMS as readonly string[]).includes(header.alg)) {
      throw new Error(`Insecure algorithm rejected: ${header.alg}`);
    }
    if (!(ALLOWED_ID_TOKEN_ALGORITHMS as readonly string[]).includes(header.alg)) {
      throw new Error(`Unknown or disallowed algorithm: ${header.alg}`);
    }
    if (!header.kid) throw new Error('Logout token missing kid header');

    let publicKey = await this.jwksCache.getKey(discovery.jwks_uri, header.kid, provider.issuer_url);

    const verifyOpts: jwt.VerifyOptions = {
      algorithms: [...ALLOWED_ID_TOKEN_ALGORITHMS] as jwt.Algorithm[],
      issuer: provider.issuer_url,
      audience: provider.client_id,
      clockTolerance: CLOCK_SKEW_SECONDS,
    };

    let claims: OidcIdTokenClaims;
    try {
      claims = jwt.verify(logoutToken, publicKey as unknown as string, verifyOpts) as OidcIdTokenClaims;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('invalid signature') || msg.includes('unable to verify')) {
        this.jwksCache.evict(discovery.jwks_uri);
        publicKey = await this.jwksCache.getKey(discovery.jwks_uri, header.kid, provider.issuer_url);
        try {
          claims = jwt.verify(logoutToken, publicKey as unknown as string, verifyOpts) as OidcIdTokenClaims;
        } catch {
          throw new Error('Logout token signature invalid after JWKS rotation');
        }
      } else {
        throw new Error(`Logout token validation failed: ${msg}`);
      }
    }

    if (!claims.events || typeof claims.events !== 'object' || !('http://schemas.openid.net/event/backchannel-logout' in claims.events)) {
      throw new Error('Logout token missing backchannel-logout event');
    }
    
    if (claims.nonce !== undefined) {
      throw new Error('Logout token must not contain a nonce');
    }

    if (typeof claims.jti === 'string') {
      if (this.consumedJtis.has(claims.jti)) {
        throw new Error('Logout token replayed');
      }
      this.consumedJtis.set(claims.jti, claims.exp * 1000);
      
      // Lazy cleanup
      const now = Date.now();
      for (const [jti, exp] of this.consumedJtis.entries()) {
        if (now > exp) {
          this.consumedJtis.delete(jti);
        }
      }
    }

    return claims;
  }
}
