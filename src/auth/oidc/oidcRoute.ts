import { NextFunction, Request, Response, Router } from 'express';
import { AuthenticatedRequest } from '../../middleware/auth';
import {
  createRateLimitMiddleware,
  RateLimitOptions,
  RateLimitStore,
} from '../../middleware/rateLimit';
import { OidcAdapterService } from './oidcAdapterService';
import { OidcProviderRepository, CreateOidcProviderInput } from '../../db/repositories/oidcProviderRepository';
import { UserRepository } from '../../db/repositories/userRepository';
import { OidcGroupMappingRepository } from '../../db/repositories/oidcGroupMappingRepository';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import { sessionStore } from '../../lib/sessionStore';
import { globalMetrics } from '../../lib/metrics';
import {
  ApprovalAlreadyApprovedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalSelfApprovalError,
  DuplicateApprovalError,
  JwksRefreshApprovalGate,
} from './jwksRefreshApprovalGate';

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
  /** Dual-control approval gate; defaults to a fresh in-memory gate. */
  approvalGate?: JwksRefreshApprovalGate;
  /**
   * Rate-limit options for the force-refresh endpoint (tests tighten these).
   * Pass a dedicated `store` when multiple router instances share a process
   * (e.g. tests) so per-admin buckets do not bleed across instances.
   */
  rateLimitOptions?: RateLimitOptions & { store?: RateLimitStore };
}

const JWKS_REFRESH_RATE_LIMIT = 10; // 10 calls / min / admin (each dual-control step counts)
const JWKS_REFRESH_RATE_WINDOW_MS = 60_000;

/**
 * OIDC SSO router.
 *
 * Routes:
 *  GET  /api/auth/oidc/authorize?tenantId=…   — start PKCE flow (redirect)
 *  GET  /api/auth/oidc/callback?code=…&state=… — handle IdP callback
 *  POST /api/auth/oidc/providers               — (admin) register a provider
 *  GET  /api/auth/oidc/providers               — (admin) list providers
 *  POST /auth/oidc/jwks/refresh                — (admin, dual-control) force-reload JWKS
 */
export function createOidcRouter(deps: OidcRouterDependencies): Router {
  const { oidcAdapter, oidcProviderRepo, userRepo, oidcGroupMappingRepo, auditLogRepo, requireAdmin, auditRefresh } = deps;
  const router = Router();
  const approvalGate = deps.approvalGate ?? new JwksRefreshApprovalGate();

  // requireAdmin populates req.user with { id, role } — the shared rate-limit
  // middleware keys per-user buckets on req.user.sub, so mirror id → sub after
  // admin auth. This keeps the bucket tied to the verified admin identity
  // rather than a shared egress IP.
  const fillRateLimitSubject = (req: Request, _res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (user && typeof user.id === 'string' && !user.sub) {
      user.sub = user.id;
    }
    next();
  };

  const refreshLimiter = createRateLimitMiddleware({
    limit: JWKS_REFRESH_RATE_LIMIT,
    windowMs: JWKS_REFRESH_RATE_WINDOW_MS,
    perUser: true,
    keyPrefix: 'oidc-jwks-refresh',
    message: 'JWKS refresh is rate-limited; try again later',
    ...deps.rateLimitOptions,
  });

  const emitAudit = (event: Record<string, unknown>) => {
    void auditRefresh?.({ timestamp: new Date().toISOString(), action: 'jwks_refresh', ...event });
  };

  /**
   * Dual-control force-refresh handler.
   *
   * Step 1 — body `{ issuer?: string }` (no approvalId): proposes a refresh
   * for the issuer (or all tracked issuers when omitted) and records the
   * caller as the first approver. Returns 202 with an approvalId.
   *
   * Step 2 — body `{ approvalId: string }`: a *different* admin approves
   * within the gate's time window, which executes the reload. Returns 200
   * with the refreshed issuer(s).
   *
   * Every outcome is audited (requesting admin, approving admin, scope,
   * timestamp). Rate-limited per admin by `refreshLimiter`.
   */
  const handleRefreshRequest = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const actorId = String(req.user?.id ?? req.user?.sub ?? req.ip ?? 'anonymous');
      const rawIssuer = typeof req.body?.issuer === 'string' ? req.body.issuer.trim() : '';
      const issuer = rawIssuer.length > 0 ? rawIssuer : undefined;
      const approvalId = typeof req.body?.approvalId === 'string' ? req.body.approvalId.trim() : '';
      const baseEvent = { actorId, issuer, scope: issuer ?? 'all_tracked_issuers' };

      // ── Step 2: second-admin approval + execution ──────────────────────
      if (approvalId) {
        let approval;
        try {
          approval = approvalGate.approve(approvalId, actorId);
        } catch (err) {
          if (err instanceof ApprovalNotFoundError) {
            emitAudit({ ...baseEvent, approvalId, status: 'blocked', reason: 'unknown_approval' });
            res.status(404).json({ error: 'Not Found', message: err.message });
            return;
          }
          if (err instanceof ApprovalExpiredError) {
            emitAudit({ ...baseEvent, approvalId, status: 'blocked', reason: 'expired_approval' });
            res.status(409).json({ error: 'Conflict', message: err.message });
            return;
          }
          if (err instanceof ApprovalSelfApprovalError) {
            emitAudit({ ...baseEvent, approvalId, status: 'blocked', reason: 'self_approval' });
            res.status(403).json({ error: 'Forbidden', message: err.message });
            return;
          }
          if (err instanceof ApprovalAlreadyApprovedError) {
            emitAudit({ ...baseEvent, approvalId, status: 'blocked', reason: 'already_approved' });
            res.status(409).json({ error: 'Conflict', message: err.message });
            return;
          }
          throw err;
        }

        const executeEvent = {
          ...baseEvent,
          approvalId,
          proposerId: approval.proposer,
          approverId: actorId,
        };

        try {
          if (approval.issuer) {
            await oidcAdapter.refreshJwks(approval.issuer);
            emitAudit({ ...executeEvent, issuers: [approval.issuer], status: 'success' });
            res.status(200).json({
              ok: true,
              status: 'approved',
              approvalId,
              refreshedIssuers: [approval.issuer],
              refreshedAt: new Date().toISOString(),
            });
          } else {
            const result = await oidcAdapter.refreshAllJwks();
            emitAudit({
              ...executeEvent,
              issuers: result.refreshed,
              failed: result.failed,
              status: result.refreshed.length > 0 || result.failed.length === 0 ? 'success' : 'failed',
            });
            if (result.refreshed.length === 0 && result.failed.length > 0) {
              res.status(502).json({
                error: 'Bad Gateway',
                message: 'JWKS refresh failed for all tracked issuers',
                failed: result.failed,
              });
              return;
            }
            res.status(200).json({
              ok: true,
              status: 'approved',
              approvalId,
              refreshedIssuers: result.refreshed,
              ...(result.failed.length > 0 ? { failed: result.failed } : {}),
              refreshedAt: new Date().toISOString(),
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitAudit({ ...executeEvent, status: 'failed', reason: message });
          throw err;
        }
        return;
      }

      // ── Step 1: propose (first approval) ───────────────────────────────
      try {
        const approval = approvalGate.propose(actorId, issuer);
        emitAudit({
          actorId,
          proposerId: actorId,
          issuer: approval.issuer,
          scope: approval.scope,
          approvalId: approval.approvalId,
          status: 'pending_second_approval',
        });
        res.status(202).json({
          ok: true,
          status: 'pending_second_approval',
          approvalId: approval.approvalId,
          proposer: approval.proposer,
          issuer: approval.issuer ?? null,
          scope: approval.scope,
          expiresAt: new Date(approval.expiresAt).toISOString(),
        });
      } catch (err) {
        if (err instanceof DuplicateApprovalError) {
          emitAudit({ ...baseEvent, approvalId: err.existingApprovalId, status: 'blocked', reason: 'duplicate_proposal' });
          res.status(409).json({
            error: 'Conflict',
            message: err.message,
            details: { approvalId: err.existingApprovalId },
          });
          return;
        }
        throw err;
      }
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

  router.post(
    '/api/auth/oidc/jwks/refresh',
    requireAdmin,
    fillRateLimitSubject,
    refreshLimiter,
    handleRefreshRequest,
  );
  router.post(
    '/auth/oidc/jwks/refresh',
    requireAdmin,
    fillRateLimitSubject,
    refreshLimiter,
    handleRefreshRequest,
  );

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
