import { NextFunction, Request, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import { OidcAdapterService } from './oidcAdapterService';
import { OidcProviderRepository, CreateOidcProviderInput } from '../../db/repositories/oidcProviderRepository';
import { UserRepository } from '../../db/repositories/userRepository';
import { OidcGroupMappingRepository } from '../../db/repositories/oidcGroupMappingRepository';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import { sessionStore } from '../../lib/sessionStore';
import { globalMetrics } from '../../lib/metrics';

export interface OidcRouterDependencies {
  oidcAdapter: OidcAdapterService;
  oidcProviderRepo: OidcProviderRepository;
  userRepo?: UserRepository;
  oidcGroupMappingRepo?: OidcGroupMappingRepository;
  auditLogRepo?: AuditLogRepository;
  /** Express middleware that enforces admin role and attaches req.user */
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  /** Optional audit hook for JWKS refresh events */
  auditRefresh?: (event: Record<string, unknown>) => void | Promise<void>;
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
  const { oidcAdapter, oidcProviderRepo, userRepo, oidcGroupMappingRepo, auditLogRepo, requireAdmin, auditRefresh } = deps;
  const router = Router();
  const refreshCooldownMs = 60_000;
  const refreshAttempts = new Map<string, number>();

  const handleRefreshRequest = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const issuerUrl = typeof req.body?.issuerUrl === 'string' ? req.body.issuerUrl : undefined;
      const confirmationHeader = req.get('x-revora-oidc-jwks-confirmation') === 'true';
      const confirmationBody = req.body?.confirmation === true || req.body?.confirmation === 'true';
      const confirmed = confirmationHeader && confirmationBody;
      const actorId = req.user?.id ?? req.ip ?? 'anonymous';
      const key = `${actorId}:${issuerUrl ?? 'global'}`;
      const now = Date.now();

      if (!issuerUrl) {
        await auditRefresh?.({ action: 'jwks_refresh', actorId, issuerUrl, status: 'blocked', reason: 'missing_issuer' });
        res.status(400).json({ error: 'Bad Request', message: 'issuerUrl is required' });
        return;
      }

      if (!confirmed) {
        await auditRefresh?.({ action: 'jwks_refresh', actorId, issuerUrl, status: 'blocked', reason: 'missing_confirmation' });
        res.status(400).json({ error: 'Bad Request', message: 'Dual confirmation is required' });
        return;
      }

      const lastAttempt = refreshAttempts.get(key) ?? 0;
      if (now - lastAttempt < refreshCooldownMs) {
        await auditRefresh?.({ action: 'jwks_refresh', actorId, issuerUrl, status: 'blocked', reason: 'rate_limited' });
        res.status(429).json({ error: 'Too Many Requests', message: 'JWKS refresh is rate-limited for this actor' });
        return;
      }

      refreshAttempts.set(key, now);
      await oidcAdapter.refreshJwks(issuerUrl);
      await auditRefresh?.({ action: 'jwks_refresh', actorId, issuerUrl, status: 'success' });
      res.status(200).json({ ok: true, issuerUrl, refreshedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  };

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

      let mappedRole: 'startup' | 'investor' | undefined;
      const incomingGroups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
      
      if (incomingGroups.length > 0 && oidcGroupMappingRepo) {
        const mappings = await oidcGroupMappingRepo.findByTenantId(provider.tenant_id);
        for (const group of incomingGroups) {
          const match = mappings.find(m => m.claim_group === group);
          if (match) {
            mappedRole = match.revora_role;
            break;
          }
        }
      }

      if (claims.email && userRepo && auditLogRepo) {
        const user = await userRepo.findByEmail(claims.email);
        if (user) {
          let groupsChanged = false;
          const lastGroups = user.last_oidc_groups || [];
          
          if (incomingGroups.length !== lastGroups.length || !incomingGroups.every(g => lastGroups.includes(g)) || !lastGroups.every((g: string) => incomingGroups.includes(g))) {
            groupsChanged = true;
          }

          if (groupsChanged) {
            await auditLogRepo.createAuditLog({
              user_id: user.id,
              action: 'oidc.claim.changed',
              details: JSON.stringify({
                old_groups: lastGroups,
                new_groups: incomingGroups
              })
            });
          }

          const updates: any = { id: user.id };
          let shouldUpdate = false;
          
          if (groupsChanged) {
            updates.last_oidc_groups = incomingGroups;
            shouldUpdate = true;
          }
          if (mappedRole) {
            updates.role = mappedRole;
            shouldUpdate = true;
          }

          if (shouldUpdate) {
             await userRepo.updateUser(updates);
          }
        }
      }

      res.status(200).json({
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        issuer: claims.iss,
        tenantId: provider.tenant_id,
        mappedRole,
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

  router.post('/api/auth/oidc/jwks/refresh', requireAdmin, handleRefreshRequest);
  router.post('/auth/oidc/jwks/refresh', requireAdmin, handleRefreshRequest);

  // ── Logout flow ──────────────────────────────────────────────────────────
  const handleLogoutRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const logoutToken = (req.method === 'POST' ? req.body.logout_token : req.query.logout_token) as string | undefined;
      
      if (!logoutToken) {
        res.status(400).json({ error: 'Bad Request', message: 'logout_token is required' });
        return;
      }

      let header: { alg?: string; kid?: string };
      let payload: { iss?: string };
      try {
        const [h, p] = logoutToken.split('.');
        header = JSON.parse(Buffer.from(h, 'base64url').toString());
        payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      } catch {
        res.status(400).json({ error: 'Bad Request', message: 'Malformed logout token' });
        return;
      }

      if (!payload.iss) {
        res.status(400).json({ error: 'Bad Request', message: 'Logout token missing issuer' });
        return;
      }

      const provider = await oidcProviderRepo.findByIssuerUrl(payload.iss);
      if (!provider) {
        res.status(400).json({ error: 'Bad Request', message: 'Provider not found for issuer' });
        return;
      }

      const discovery = await oidcAdapter.getDiscovery(provider.issuer_url);
      const claims = await oidcAdapter.validateLogoutToken(logoutToken, provider, discovery);
      
      await sessionStore.deleteAllForUser(claims.sub);
      globalMetrics.incrementCounter('oidc.logout.processed', { status: 'success' });
      
      res.status(200).json({ ok: true, message: 'Logged out successfully' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('expired') || msg.includes('Invalid') || msg.includes('mismatch') || msg.includes('replayed')) {
        res.status(400).json({ error: 'Bad Request', message: msg });
        return;
      }
      next(err);
    }
  };

  router.get('/api/auth/oidc/logout', handleLogoutRequest);
  router.post('/api/auth/oidc/logout', handleLogoutRequest);
  router.get('/auth/oidc/logout', handleLogoutRequest);
  router.post('/auth/oidc/logout', handleLogoutRequest);

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
