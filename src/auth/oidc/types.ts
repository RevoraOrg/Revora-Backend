/** Shape of an OIDC discovery document (RFC 8414). */
export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
  /** Populated by the cache: unix ms timestamp after which to re-fetch. */
  _cachedUntil?: number;
}

/** Decoded, validated OIDC ID token claims. */
export interface OidcIdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [key: string]: unknown;
}

/** Algorithms allowed for ID-token signing (asymmetric only). */
export const ALLOWED_ID_TOKEN_ALGORITHMS = [
  'RS256', 'RS384', 'RS512',
  'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512',
] as const;

/** Algorithms always rejected — fail-closed. */
export const BLOCKED_ID_TOKEN_ALGORITHMS = ['none', 'HS256', 'HS384', 'HS512'] as const;

/** Server-side PKCE + nonce state bound to a `state` parameter. */
export interface OidcFlowState {
  tenantId: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number; // unix ms
}

export interface OidcTokenResponse {
  access_token: string;
  token_type: string;
  id_token: string;
  expires_in?: number;
  refresh_token?: string;
}

/** DB row for an OIDC provider configuration. */
export interface OidcProviderRow {
  id: string;
  tenant_id: string;
  name: string;
  issuer_url: string;
  client_id: string;
  client_secret: string | null;
  scopes: string;
  redirect_uris: string; // comma-separated
  enabled: boolean;
  created_at: Date;
}
