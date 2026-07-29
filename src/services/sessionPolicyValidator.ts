import { OidcProviderRepository } from '../db/repositories/oidcProviderRepository';

export class SessionPolicyValidator {
  constructor(
    private readonly oidcProviderRepo: OidcProviderRepository,
    private readonly appBaseUrl: string = process.env.APP_BASE_URL || 'http://localhost:3000'
  ) {}

  /**
   * Validates if a tenant can opt into SameSite=Strict session policy.
   * Throws an error if the tenant has configured cross-site OAuth/OIDC redirect URIs.
   */
  async validateStrictOptIn(tenantId: string): Promise<void> {
    const provider = await this.oidcProviderRepo.findByTenantId(tenantId);
    if (!provider) {
      return; // No provider, safe to use Strict
    }

    const appOrigin = new URL(this.appBaseUrl).origin;
    const uris = provider.redirect_uris.split(',').map(u => u.trim());

    for (const uri of uris) {
      try {
        const redirectOrigin = new URL(uri).origin;
        if (redirectOrigin !== appOrigin) {
          throw new Error(`Cannot opt-in to Strict mode: configured cross-site redirect URI found (${uri})`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Cannot opt-in')) {
          throw err;
        }
        // Invalid URL, assume it might be a relative path which is same-site
      }
    }
  }
}
