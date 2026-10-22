import {
  ALLOWED_ID_TOKEN_ALGORITHMS,
  BLOCKED_ID_TOKEN_ALGORITHMS,
  OidcDiscoveryDocument,
  OidcIdTokenClaims,
  OidcFlowState,
  OidcTokenResponse,
  OidcProviderRow
} from './types';

describe('OIDC Types and Constants', () => {
  describe('ID Token Algorithms', () => {
    it('should define allowed algorithms correctly', () => {
      expect(ALLOWED_ID_TOKEN_ALGORITHMS).toContain('RS256');
      expect(ALLOWED_ID_TOKEN_ALGORITHMS).not.toContain('none');
      expect(ALLOWED_ID_TOKEN_ALGORITHMS.length).toBeGreaterThan(0);
    });

    it('should define blocked algorithms correctly', () => {
      expect(BLOCKED_ID_TOKEN_ALGORITHMS).toContain('none');
      expect(BLOCKED_ID_TOKEN_ALGORITHMS).toContain('HS256');
    });

    it('should not have overlapping allowed and blocked algorithms', () => {
      const allowedSet = new Set(ALLOWED_ID_TOKEN_ALGORITHMS);
      for (const blocked of BLOCKED_ID_TOKEN_ALGORITHMS) {
        expect(allowedSet.has(blocked as any)).toBe(false);
      }
    });
  });

  describe('Type assignments (compile-time behavior and fixture coverage)', () => {
    it('should conform to OidcDiscoveryDocument shape', () => {
      const doc: OidcDiscoveryDocument = {
        issuer: 'https://issuer.example.com',
        authorization_endpoint: 'https://issuer.example.com/auth',
        token_endpoint: 'https://issuer.example.com/token',
        jwks_uri: 'https://issuer.example.com/jwks',
        id_token_signing_alg_values_supported: ['RS256'],
        _cachedUntil: Date.now() + 3600000,
      };

      expect(doc.issuer).toBe('https://issuer.example.com');
      expect(doc.id_token_signing_alg_values_supported).toContain('RS256');
    });

    it('should conform to OidcIdTokenClaims shape', () => {
      const claims: OidcIdTokenClaims = {
        iss: 'https://issuer.example.com',
        sub: 'user123',
        aud: 'client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'random-nonce-value',
        email: 'user@example.com',
        email_verified: true,
        name: 'Test User',
        custom_claim: 'custom_value',
      };

      expect(claims.sub).toBe('user123');
      expect(claims.custom_claim).toBe('custom_value');
    });

    it('should conform to OidcFlowState shape', () => {
      const state: OidcFlowState = {
        tenantId: 'tenant-1',
        codeVerifier: 'verifier',
        nonce: 'nonce',
        redirectUri: 'https://app.example.com/callback',
        expiresAt: Date.now() + 300000,
      };

      expect(state.tenantId).toBe('tenant-1');
    });

    it('should conform to OidcTokenResponse shape', () => {
      const response: OidcTokenResponse = {
        access_token: 'access-123',
        token_type: 'Bearer',
        id_token: 'id-123',
        expires_in: 3600,
        refresh_token: 'refresh-123',
      };

      expect(response.access_token).toBe('access-123');
    });

    it('should conform to OidcProviderRow shape', () => {
      const row: OidcProviderRow = {
        id: 'provider-1',
        tenant_id: 'tenant-1',
        name: 'My Provider',
        issuer_url: 'https://issuer.example.com',
        client_id: 'client-id',
        client_secret: 'client-secret',
        scopes: 'openid profile email',
        redirect_uris: 'https://app.example.com/callback',
        enabled: true,
        created_at: new Date(),
      };

      expect(row.id).toBe('provider-1');
    });
  });
});
