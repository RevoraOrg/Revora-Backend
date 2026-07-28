import { NextFunction, Request, Response, Router } from 'express';
import { OidcAdapterService } from './oidcAdapterService';
import { OidcProviderRepository, CreateOidcProviderInput } from '../../db/repositories/oidcProviderRepository';

export interface OidcRouterDependencies {
  oidcAdapter: OidcAdapterService;
  oidcProviderRepo: OidcProviderRepository;
  /** Express middleware that enforces admin role and attaches req.user */
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
}

/**
 * OIDC SSO router.
 *
 * Routes:
 *  GET  /api/auth/oidc/authorize?tenantId=…   — start PKCE flow (redirect)
 *  GET  /api/auth/oidc/callback?code=…&state=… — handle IdP callback
 *  POST /api/auth/oidc/providers               — (admin) register a provider
 *  GET  /api/auth/oidc/providers               — (admin) list providers
 */
export function createOidcRouter(deps: OidcRouterDependencies): Router {
  const { oidcAdapter, oidcProviderRepo, requireAdmin } = deps;
  const router = Router();

  // ── Start SSO flow ───────────────────────────────────────────────────────
  router.get('/api/auth/oidc/authorize', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.query['tenantId'] as string | undefined;
      if (!tenantId) {
        res.status(400).json({ error: 'Bad Request', message: '"tenantId" query param is required' });
        return;
      }

      const provider = await oidcProviderRepo.findByTenantId(tenantId);
      if (!provider) {
        res.status(404).json({ error: 'Not Found', message: `No OIDC provider for tenant: ${tenantId}` });
        return;
      }

      const { url } = await oidcAdapter.buildAuthorizeUrl(provider);
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  });

  // ── OAuth callback ───────────────────────────────────────────────────────
  router.get('/api/auth/oidc/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };
      if (!code || !state) {
        res.status(400).json({ error: 'Bad Request', message: '"code" and "state" are required' });
        return;
      }

      // Recover tenantId from server-side flow state
      const flowState = oidcAdapter.consumeFlowState(state);
      const provider = await oidcProviderRepo.findByTenantId(flowState.tenantId);
      if (!provider) {
        res.status(404).json({ error: 'Not Found', message: 'Provider not found for this flow' });
        return;
      }

      // Re-insert state so handleCallback can consume it (already consumed above
      // — pass claims directly to avoid double-consume)
      const discovery = await oidcAdapter.getDiscovery(provider.issuer_url);
      const tokens = await (oidcAdapter as any).exchangeCode(code, flowState, provider, discovery);
      const claims = await oidcAdapter.validateIdToken(tokens.id_token, provider, discovery, flowState.nonce);

      res.status(200).json({
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        issuer: claims.iss,
        tenantId: provider.tenant_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('expired') || msg.includes('Invalid') || msg.includes('mismatch')) {
        res.status(401).json({ error: 'Unauthorized', message: msg });
        return;
      }
      next(err);
    }
  });

  // ── Admin: register provider ─────────────────────────────────────────────
  router.post('/api/auth/oidc/providers', requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { tenantId, name, issuerUrl, clientId, clientSecret, scopes, redirectUris } =
        req.body as CreateOidcProviderInput & { tenantId: string; issuerUrl: string; redirectUris: string };

      if (!tenantId || !name || !issuerUrl || !clientId || !redirectUris) {
        res.status(400).json({ error: 'Bad Request', message: 'tenantId, name, issuerUrl, clientId, redirectUris are required' });
        return;
      }

      const provider = await oidcProviderRepo.create({ tenantId, name, issuerUrl, clientId, clientSecret, scopes, redirectUris });
      // Never leak clientSecret in response
      const { client_secret: _secret, ...safe } = provider;
      res.status(201).json(safe);
    } catch (err) {
      next(err);
    }
  });

  // ── Admin: list providers ────────────────────────────────────────────────
  router.get('/api/auth/oidc/providers', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const providers = await oidcProviderRepo.findAll();
      res.status(200).json(providers.map(({ client_secret: _s, ...safe }) => safe));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
