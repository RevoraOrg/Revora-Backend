import "dotenv/config";
import { timingSafeEqual } from "crypto";
import { Pool } from "pg";
import express, {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import morgan from "morgan";
import { closePool, dbHealth, query as dbQuery } from "./db/client";
import { createCorsMiddleware } from "./middleware/cors";
import { errorHandler } from "./middleware/errorHandler";
import { requestIdMiddleware } from "./middleware/requestId";
import { Errors } from "./lib/errors";
import { globalSampler } from "./lib/sampler";
import { globalLogger } from "./lib/logger";
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "./lib/stellarRpcFailure";
import { createHealthRouter } from "./routes/health";
import vestingRouter from "./routes/vesting";
import { createOfferingValidationRouter } from "./routes/offeringValidation";
import { createStartupAuthTierLimiter } from "./middleware/startupAuthRateTierPolicy";
import { env } from "./config/env";
import { validateWebhookUrl, SsrfValidationError } from "./lib/ssrfProtection";
import {
  WebhookEndpointRepository,
  WebhookDelivery,
} from "./db/repositories/webhookEndpointRepository";
import {
  WebhookService,
  WebhookPayload,
  WebhookEventType,
} from "./services/webhookService";
import { OutboxRepository } from "./db/repositories/outboxRepository";
import { OutboxDispatcher, makeWebhookDispatchFn } from "./services/outboxDispatcher";
import { pool } from "./db/pool";
import {
  globalMetrics,
  WEBHOOK_QUEUE_DEPTH_GAUGE,
  WEBHOOK_QUEUE_SHED_TOTAL,
} from "./lib/metrics";
import { createPasswordResetRouter } from "./routes/passwordReset";
import { emailService } from "./services/emailService";
import { EmailDeliverabilityService } from "./services/emailDeliverabilityService";
import { EmailDeliverabilityRepository } from "./db/repositories/emailDeliverabilityRepository";
import { createEmailWebhooksRouter } from "./routes/emailWebhooks";
import { createAdminRouter } from "./routes/admin";
import { createAdminLedgerExportRouter } from "./routes/adminLedgerExport";
import { createAdminWebhookRouter } from "./routes/adminWebhooks";
import { AccountingLedgerService } from "./services/accountingLedgerService";
import { DistributionRepository } from "./db/repositories/distributionRepository";
import { BalanceSnapshotRepository } from "./db/repositories/balanceSnapshotRepository";
import { OfferingRepository } from "./db/repositories/offeringRepository";
import { ScheduledDistributionRepository } from "./db/repositories/scheduledDistributionRepository";
import { BalanceRow } from "./services/distributionEngine";
import DistributionEngine from "./services/distributionEngine";
import { DistributionStateManager } from "./services/distributionScheduler";
import createDistributionsRouter, {
  DistributionAccountRepo,
  OfferingRepo,
} from "./routes/distributions";
import createPayoutsRouter, { PayoutRepo } from "./routes/payouts";
import { createAdminKycRiskTierRouter } from "./routes/adminKycRiskTier";
import { AuditLogRepository } from "./db/repositories/auditLogRepository";
import { TenantSettingsRepository } from "./db/repositories/tenantSettingsRepository";
import { ContractUpgradeOrchestratorService } from "./services/contractUpgradeOrchestratorService";
import { createContractUpgradeRouter } from "./routes/contractUpgradeRoutes";
import { AuditPurgeService } from "./services/auditPurgeService";
import { SessionCompactionService } from "./services/sessionCompactionService";
import { SessionRepository } from "./db/repositories/sessionRepository";
import { RetentionLabelRepository } from "./db/repositories/retentionLabelRepository";
import { RetentionLabelService } from "./services/retentionLabelService";
import { PayoutDriftRepository } from "./db/repositories/payoutDriftRepository";
import { PayoutDriftDetector } from "./services/payoutDriftDetector";
import { MetricsCollector } from "./lib/metrics";
import {
  createStellarTransactionVerifier,
  StellarTransactionVerifier,
} from "./lib/stellarTransactionVerifier";
import { createReconciliationMetricsHandler } from "./routes/reconciliationRoutes";
import { createReconciliationSchedulerRuntime } from "./services/reconciliationScheduler";
import { createAMLRoutes } from "./routes/amlRoutes";
import { createLedgerExportRouter } from "./routes/ledgerExport";
import { LedgerExportService } from "./services/ledgerExportService";
import { PgLedgerEntryRepository } from "./db/repositories/ledgerEntryRepository";
import { createAMLService } from "./aml/amlService";
import { InMemorySecurityAuditRepository, AuditLogSecurityAuditRepository } from "./security/audit";
import { createMobileCompanionRouter } from "./routes/mobileCompanion";
import { InMemoryDeviceKeyStore } from "./middleware/deviceSignature";
import { Keypair } from '@stellar/stellar-sdk';
import { OfacSanctionsLoader } from './services/ofacSanctionsLoader';
import { SanctionsListVersionsRepository } from './db/repositories/sanctionsListVersionsRepository';
import { SanctionsListDiffService } from './services/sanctionsListDiffService';
import { createComplianceRouter } from './routes/compliance';
import { createScimRouter } from './routes/scim';
import { UserRepository } from './db/repositories/userRepository';
import taxationRouter from './routes/taxation';
import { PdfRenderJobRepository } from './db/repositories/pdfRenderJobRepository';
import { InMemoryStatementPdfStorage } from './services/statementPdfService';
import createStatementsRouter from './routes/statements';
import { createRequireAuth } from './middleware/auth';
// \u2500\u2500 Auth routers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { createLoginRouter } from './auth/login/loginRoute';
import { createRefreshRouter } from './auth/refresh/refreshRoute';
import { createLogoutRouter } from './auth/logout/logoutRoute';
import { createChangePasswordRouter } from './auth/changePassword/changePasswordRoute';
import { createSocialAuthRouter } from './auth/social/socialAuthRoute';
// \u2500\u2500 Auth services / adapters \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { LoginService } from './auth/login/loginService';
import { RefreshService } from './auth/refresh/refreshService';
import { RefreshTokenRepositoryAdapter } from './auth/refresh/repositoryAdapter';
import { JwtTokenServiceAdapter } from './auth/refresh/tokenServiceAdapter';
import { SocialAuthService } from './auth/social/socialAuthService';
import { SocialUserRepositoryAdapter } from './auth/social/socialUserRepositoryAdapter';
import { createDefaultSocialTokenVerifierFromEnv } from './auth/social/providerVerifiers';
import { SocialIdentityRepository } from './db/repositories/socialIdentityRepository';
import {
  JwtIssuer,
  UserRole,
  UserRepository as IUserRepository,
  SessionRepository as ISessionRepository,
} from './auth/login/types';
import { issueToken } from './lib/jwt';
import { Logger as AppLogger } from './lib/logger';

export { parseMoneyString } from "./routes/offeringValidation";

const port = env.PORT;
const API_VERSION_PREFIX = env.API_VERSION_PREFIX;

interface AppDependencies {
  healthQuery?: typeof dbQuery;
  healthStatus?: typeof dbHealth;
  sessionRepository?: Pick<SessionRepository, "findById">;
  distributionEngine?: Pick<DistributionEngine, "distribute" | "previewRun">;
  distributionOfferingRepo?: OfferingRepo;
  distributionRepo?: DistributionAccountRepo &
    Pick<DistributionRepository, "listPayoutsByInvestor">;
  payoutRepo?: PayoutRepo;
  balanceSnapshotRepo?: Pick<
    BalanceSnapshotRepository,
    "findByOfferingAndPeriod"
  >;
  scheduledDistributionRepo?: Pick<
    ScheduledDistributionRepository,
    "create" | "findByOffering" | "findAll" | "markCancelled"
  >;
  distributionStateManager?: Pick<DistributionStateManager, "pause" | "resume">;
  accountingLedger?: AccountingLedgerService;
}

/**
 * Bearer-token guard for the reconciliation metrics endpoint.
 *
 * Security assumptions:
 *  - In production a `METRICS_TOKEN` MUST be set; otherwise the endpoint is
 *    down (503) rather than exposed unauthenticated.
 *  - Token comparison uses a constant-time compare to avoid timing oracles.
 *  - In `development`/`test` the guard is bypassed for operator convenience,
 *    mirroring the existing Prometheus `/metrics` endpoint behaviour.
 */
function createMetricsAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const metricsToken = process.env.METRICS_TOKEN;
    const nodeEnv = process.env.NODE_ENV;

    if (nodeEnv === "development" || nodeEnv === "test") {
      next();
      return;
    }
    if (!metricsToken) {
      res.status(503).json({
        error: "Metrics endpoint not configured",
        message: "METRICS_TOKEN environment variable must be set",
      });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized", message: "Bearer token required" });
      return;
    }
    const token = authHeader.substring(7);
    const matches =
      token.length === metricsToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(metricsToken));
    if (!matches) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid token" });
      return;
    }
    next();
  };
}

/**
 * @dev Stable JSON serializer used for deterministic fingerprints and tests.
 */
function stableSerialize(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }

    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }

    return input;
  };

  return JSON.stringify(normalize(value));
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function createStartupRegisterHandler(): RequestHandler {
  return (req: Request, res: Response): void => {
    const body = req.body as Record<string, unknown> | undefined;
    const email = body?.email;
    const password = body?.password;

    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    res.status(201).json({ message: "Startup user registered successfully" });
  };
}

let inFlightRequests = 0;

export function createApp(dependencies: AppDependencies = {}): express.Express {
  const app = express();
  
  app.use((_req, res, next) => {
    inFlightRequests++;
    res.on('finish', () => inFlightRequests--);
    res.on('close', () => {
      if (!res.writableFinished) inFlightRequests--;
    });
    next();
  });

  const apiRouter = express.Router();
  const healthQuery = dependencies.healthQuery ?? dbQuery;
  const healthStatus = dependencies.healthStatus ?? dbHealth;

  app.use(requestIdMiddleware());
  app.set("trust proxy", 1);
  app.use(createCorsMiddleware() as RequestHandler);
  app.use(express.json({ limit: "32kb" }));
  app.use(morgan(env.NODE_ENV === "test" ? "tiny" : "dev"));

  app.get("/health", async (_req: Request, res: Response) => {
    const db = await healthStatus();
    res.status(db.healthy ? 200 : 503).json({
      status: db.healthy ? "ok" : "degraded",
      service: "revora-backend",
      db,
    });
  });

  app.get("/health/failover", async (_req: Request, res: Response) => {
    const region = process.env.REGION ?? env.REGION;
    const activeRegion = process.env.FAILOVER_ACTIVE_REGION ?? env.FAILOVER_ACTIVE_REGION ?? region;
    const db = await healthStatus();
    res.status(db.healthy ? 200 : 503).json({
      region,
      activeRegion,
      isActive: region === activeRegion,
      db: db.healthy ? "up" : "down",
      failoverActive: region !== activeRegion,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/health", createHealthRouter(healthQuery as any, healthStatus, undefined, env.REGION));

  apiRouter.get("/overview", (_req: Request, res: Response) => {
    res.json({
      name: "Stellar RevenueShare (Revora) Backend",
      description:
        "Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).",
      version: "0.1.0",
    });
  });

  /**
   * @notice Rate-limiter tier policy enforcement for the STARTUP_REGISTER endpoint.
   *
   * Security assumptions:
   * - Tier resolution is performed via the `x-revora-rate-tier` request header.
   * - Privileged tiers (`trusted`, `internal`) require a valid shared secret in
   *   `x-revora-tier-secret`; an absent, empty, or mismatched secret causes
   *   silent downgrade to the `standard` tier (fail-safe).
   * - If no tier header is supplied, the request is treated as `standard`.
   * - Rate-limit state is in-process; a distributed store (e.g. Redis) must be
   *   substituted for multi-instance deployments.
   */
  const startupTierLimiter = createStartupAuthTierLimiter();
  apiRouter.post(
    "/startup/register",
    startupTierLimiter.middleware,
    createStartupRegisterHandler(),
  );

  apiRouter.use("/offerings", createOfferingValidationRouter());

  apiRouter.use("/vesting", vestingRouter);

  // Mount password reset router
  app.use(createPasswordResetRouter({ db: pool, emailService }));

  // Initialize email deliverability service (when enabled)
  if (env.EMAIL_DELIVERABILITY_ENABLED) {
    const emailDeliverabilityRepo = new EmailDeliverabilityRepository(pool);
    const emailDeliverabilityService = new EmailDeliverabilityService(
      emailDeliverabilityRepo,
      new MetricsCollector({ enabled: true }),
      {
        enabled: env.EMAIL_DELIVERABILITY_ENABLED,
        suppressionAutoExpireDays: env.SUPPRESSION_AUTO_EXPIRE_DAYS,
        bounceRatioAlarmThreshold: env.BOUNCE_RATIO_ALARM_THRESHOLD,
      },
    );

    // Wire into the existing email service
    emailService.setDeliverabilityService(emailDeliverabilityService);

    // Mount email bounce webhook routes
    app.use(
      '/api/v1/email/webhooks',
      createEmailWebhooksRouter(emailDeliverabilityService, {
        sendgridWebhookSecret: env.SENDGRID_EVENT_WEBHOOK_SECRET,
      }),
    );
  }

  // Initialize repositories for admin and audit routes
  const auditLogRepo = new AuditLogRepository(pool);
  const amlAuditRepo = new AuditLogSecurityAuditRepository(auditLogRepo);
  const retentionLabelService = new RetentionLabelService(
    new RetentionLabelRepository(pool),
    auditLogRepo,
  );
  const tenantSettingsRepo = new TenantSettingsRepository(pool);
  const accountingLedger =
    dependencies.accountingLedger ?? new AccountingLedgerService();
  const contractUpgradeService = env.STELLAR_SERVER_SECRET
    ? new ContractUpgradeOrchestratorService(
        pool,
        auditLogRepo,
        tenantSettingsRepo,
        Keypair.fromSecret(env.STELLAR_SERVER_SECRET),
      )
    : null;

  // Mount admin router
  apiRouter.use("/admin", createAdminRouter(auditLogRepo, retentionLabelService));
  apiRouter.use("/admin", createAdminKycRiskTierRouter(pool, amlAuditRepo));

  // Mount admin webhook dead-letter routes
  const webhookEndpointRepo = new WebhookEndpointRepository(pool);
  apiRouter.use("/admin/webhooks", createAdminWebhookRouter({ webhookEndpointRepo }));

  // Mount admin ledger double-entry export (RBAC + audited)
  apiRouter.use(
    "/admin/ledger",
    createAdminLedgerExportRouter({
      distributionAccountRepo: new DistributionRepository(pool),
      accountingLedger,
      auditLogRepo,
    }),
  );

  if (contractUpgradeService) {
    apiRouter.use(
      "/contract-upgrades",
      createContractUpgradeRouter(contractUpgradeService),
    );
  }

  // Initialize AML service and routes
  const amlService = createAMLService(pool, amlAuditRepo, 'system');
  apiRouter.use("/aml", createAMLRoutes(amlService));

  // Initialize sanctions list versioning and compliance routes
  const sanctionsVersionsRepo = new SanctionsListVersionsRepository(pool);
  const sanctionsListDiffService = new SanctionsListDiffService(sanctionsVersionsRepo);
  apiRouter.use("/compliance", createComplianceRouter(sanctionsVersionsRepo, sanctionsListDiffService));

  // Ledger export: backed by Postgres, access restricted to compliance/admin roles.
  // Migration 061_create_ledger_entries.sql must be applied before this runs.
  const ledgerRepo = new PgLedgerEntryRepository(pool);
  const ledgerExportService = new LedgerExportService(ledgerRepo);
  apiRouter.use("/ledger", createLedgerExportRouter(ledgerExportService, requireCompliance));

  // Investor statements (Issue #874): the fetch endpoint re-verifies the
  // persisted sha256 before serving. Storage defaults to in-memory — replace
  // with the S3-backed adapter when one is deployed so completed renders are
  // retrievable across instances. Without a storage adapter, requests simply
  // 404 (no artifacts exist), which is fail-safe.
  const statementStorage = new InMemoryStatementPdfStorage();
  const pdfRenderJobRepo = new PdfRenderJobRepository(pool);
  const sessionRepo = dependencies.sessionRepository ?? new SessionRepository(pool);

  const offeringRepo =
    dependencies.distributionOfferingRepo ?? new OfferingRepository(pool);
  const distributionRepo =
    dependencies.distributionRepo ?? new DistributionRepository(pool);
  const payoutRepo: PayoutRepo =
    dependencies.payoutRepo ?? {
      async listPayoutsByInvestor(investorId) {
        const payouts = await distributionRepo.listPayoutsByInvestor(investorId);
        return payouts.map((payout) => ({
          id: payout.id,
          distribution_run_id: payout.distribution_id,
          investor_id: payout.investor_id,
          amount: payout.amount,
          status: payout.status,
          transaction_hash: payout.tx_hash ?? undefined,
          created_at: payout.created_at,
          updated_at: payout.updated_at,
        }));
      },
    };
  const balanceSnapshotRepo =
    dependencies.balanceSnapshotRepo ?? new BalanceSnapshotRepository(pool);
  /**
   * @dev Distribution calculations read persisted snapshots keyed by period;
   * this app composition deliberately does not start the separate scheduler.
   */
  const balanceProvider = {
    async getBalances(
      offeringId: string,
      period: { id: string },
    ): Promise<BalanceRow[]> {
      const snapshots = await balanceSnapshotRepo.findByOfferingAndPeriod(
        offeringId,
        period.id,
      );
      return snapshots.map((snapshot) => ({
        investor_id: snapshot.holder_address_or_id,
        balance: Number(snapshot.balance),
      }));
    },
  };
  const distributionEngine =
    dependencies.distributionEngine ??
    new DistributionEngine(
      offeringRepo,
      distributionRepo,
      balanceProvider,
      {},
      pool,
    );
  const scheduledDistributionRepo =
    dependencies.scheduledDistributionRepo ??
    new ScheduledDistributionRepository(pool);
  const distributionStateManager =
    dependencies.distributionStateManager ?? new DistributionStateManager();

  apiRouter.use(
    createDistributionsRouter({
      distributionEngine,
      offeringRepo,
      verifyJWT: createRequireAuth(sessionRepo),
      distributionStateManager,
      distributionAccountRepo: distributionRepo,
      accountingLedger,
      scheduledDistributionRepo,
    }),
  );
  apiRouter.use(
    createPayoutsRouter({
      payoutRepo,
      verifyJWT: createRequireAuth(sessionRepo),
      routePath: "/investments/payouts",
    }),
  );
  apiRouter.use(
    "/statements",
    createStatementsRouter({
      jobRepo: pdfRenderJobRepo,
      storage: statementStorage,
      verifyJWT: createRequireAuth(sessionRepo),
    }),
  );

  // Mount taxation routes for per-lot cost-basis tax reporting
  app.use(API_VERSION_PREFIX + '/taxation', taxationRouter);

  // Expose reconciliation alarms and discrepancy metrics (OpenMetrics subset).
  // Guards alarms via bearer token in production; bypassed in dev/test.
  app.get(
    "/metrics/reconciliation",
    createMetricsAuthMiddleware(),
    createReconciliationMetricsHandler(globalMetrics),
  );

  // ── Auth routes (login, refresh, logout, social, change-password) ────────
  //
  // Security assumptions:
  //  - JwtIssuerImpl signs tokens with the same issueToken helper used
  //    everywhere else; key rotation is controlled via env (JWT_SECRET).
  //  - authSessionRepo is a fresh SessionRepository instance. Both
  //    createRequireAuth and the auth services share the same underlying
  //    pool, so sessions created at login are immediately honoured.
  //  - Adapters translate concrete DB repositories to the narrow port
  //    interfaces expected by each auth service without duplicating logic.
  //  - Social-login endpoints are rate-limited per provider+sub via the
  //    anti-enumeration middleware inside createSocialAuthRouter.
  // ────────────────────────────────────────────────────────────────────────

  // Local adapter classes — scoped inside createApp so they share closure.
  class IndexUserRepositoryAdapter implements IUserRepository {
    constructor(private readonly repo: UserRepository) {}
    async findByEmail(email: string) {
      const user = await this.repo.findByEmail(email);
      if (!user) return null;
      return { id: user.id, email: user.email, role: user.role as UserRole, passwordHash: user.password_hash };
    }
  }

  class IndexSessionRepositoryAdapter implements ISessionRepository {
    constructor(private readonly repo: SessionRepository) {}
    async createSession(input: { id: string; userId: string; tokenHash: string; expiresAt: Date }) {
      await this.repo.createSession({ id: input.id, user_id: input.userId, token_hash: input.tokenHash, expires_at: input.expiresAt });
    }
  }

  class IndexJwtIssuer implements JwtIssuer {
    sign(payload: { userId: string; sessionId: string; role: UserRole }) {
      const accessToken = issueToken({ subject: payload.userId, additionalPayload: { sid: payload.sessionId, role: payload.role }, expiresIn: '1h' });
      const refreshToken = issueToken({ subject: payload.userId, additionalPayload: { sid: payload.sessionId, role: payload.role, type: 'refresh' }, expiresIn: '7d' });
      return { accessToken, refreshToken };
    }
  }

  const authUserRepo = new UserRepository(pool);
  const authSessionRepo = new SessionRepository(pool);
  const requireAuthForLogin = createRequireAuth(authSessionRepo);
  const jwtIssuer = new IndexJwtIssuer();

  const loginService = new LoginService(
    new IndexUserRepositoryAdapter(authUserRepo),
    new IndexSessionRepositoryAdapter(authSessionRepo),
    jwtIssuer,
  );

  const socialAuthService = new SocialAuthService(
    new SocialUserRepositoryAdapter(authUserRepo),
    new SocialIdentityRepository(pool),
    new IndexSessionRepositoryAdapter(authSessionRepo),
    jwtIssuer,
    createDefaultSocialTokenVerifierFromEnv(),
  );

  const refreshTokenRepo = new RefreshTokenRepositoryAdapter(authSessionRepo);
  const tokenService = new JwtTokenServiceAdapter();
  const authLogger = new AppLogger({ serviceName: 'auth-refresh' });
  const refreshService = new RefreshService(refreshTokenRepo, tokenService, pool, authLogger);

  // Mount auth routes at app level (not under apiRouter) so absolute paths
  // such as /api/auth/login are served without the API_VERSION_PREFIX.
  app.use(createLoginRouter({ loginService }));
  app.use(createRefreshRouter({ refreshService }));
  app.use(createLogoutRouter({ requireAuth: requireAuthForLogin, sessionRepository: authSessionRepo }));
  app.use(createSocialAuthRouter({ socialAuthService, requireAuth: requireAuthForLogin }));
  // Change-password routes are relative paths (/me/change-password, /me/password)
  // so mount them under the versioned /users prefix.
  app.use(API_VERSION_PREFIX + '/users', createChangePasswordRouter({ db: pool, requireAuth: requireAuthForLogin }));
  app.use(API_VERSION_PREFIX, apiRouter);
  app.use((_req, _res, next) => next(Errors.notFound("Route not found")));
  app.use(errorHandler);

  return app;
}

export const __test = {
  stableSerialize,
  /**
   * @dev Exposes the tier-limiter factory for integration tests that need to
   *      inspect tier resolution or reset counters without restarting the app.
   */
  createStartupAuthTierLimiter,
  /**
   * @dev Exposes the OFAC loader for integration tests.
   */
  OfacSanctionsLoader,
};

export { classifyStellarRPCFailure, StellarRPCFailureClass };

export const app = createApp();

let isShuttingDown = false;

/* istanbul ignore next -- exercised only in real process shutdown */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  globalSampler.stop();
  console.log(`\n[server] ${signal} shutting down`);

  if (server) {
    const drainTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);
    
    // Stop accepting new connections
    const serverClosePromise = new Promise<void>((resolve, reject) => {
      server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log('[server] Stopped accepting new connections. Draining in-flight requests...');
    
    const drainStart = Date.now();
    while (inFlightRequests > 0) {
      if (Date.now() - drainStart > drainTimeoutMs) {
        console.warn(`[server] Drain timeout exceeded with ${inFlightRequests} in-flight requests. Forcing exit.`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (inFlightRequests === 0) {
      console.log('[server] All in-flight requests drained.');
      // Wait for server to fully close (e.g., closing idle keep-alive sockets)
      try {
        const remainingTime = Math.max(0, drainTimeoutMs - (Date.now() - drainStart));
        await Promise.race([
          serverClosePromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), remainingTime))
        ]);
        console.log('[server] Listener closed completely.');
      } catch (err) {
        console.warn('[server] Listener close timeout or error. Proceeding to close pool.');
      }
    }
  }

  await closePool();
  /* istanbul ignore next -- process exit is not unit-test friendly */
  process.exit(0);
}

let server: ReturnType<typeof app.listen> | undefined;

/* istanbul ignore next -- setter exists for runtime wiring compatibility */
export const setServer = (value: ReturnType<typeof app.listen>) => {
  server = value;
};

/**
 * Webhook delivery queue with exponential backoff, SSRF-aware URL blocking,
 * bounded depth, and back-pressure via deferred persistence.
 *
 * @notice When in-flight count reaches WEBHOOK_QUEUE_MAX_DEPTH the delivery is
 *         persisted as 'deferred' (never dropped) and webhook_queue_shed_total
 *         is incremented. Call resumeDeferred() to re-enqueue them once capacity
 *         is available. Shedding is idempotent per delivery: re-enqueueing an
 *         already-deferred row at capacity reuses the row and does not
 *         double-count the metric.
 */
export class WebhookQueue {
  private static repo: WebhookEndpointRepository;
  private static service: WebhookService;
  private static MAX_RETRIES = 5;
  private static INITIAL_DELAY = 1000;
  /** Number of deliveries currently scheduled / in-flight. */
  private static inFlight = 0;

  static init(repo: WebhookEndpointRepository, service: WebhookService) {
    this.repo = repo;
    this.service = service;
  }

  private static get maxDepth(): number {
    return env.WEBHOOK_QUEUE_MAX_DEPTH;
  }

  private static async isSafeUrl(url: string): Promise<boolean> {
    try {
      const result = await validateWebhookUrl(url, true);
      if (!result.valid) {
        console.error(
          `[Security] SSRF validation failed for ${url}: ${result.error?.message}`,
        );
      }
      return result.valid;
    } catch (error) {
      console.error(`[Security] Error validating webhook URL ${url}:`, error);
      return false;
    }
  }

  static getBackoffDelay(retryCount: number): number {
    if (retryCount >= this.MAX_RETRIES) return -1;
    return this.INITIAL_DELAY * Math.pow(2, retryCount);
  }

  /**
   * Count a shed delivery. Invoked only when a delivery first transitions to
   * deferred so the counter is idempotent across retries of the same row.
   */
  private static recordShed(endpointId: string): void {
    globalMetrics.incrementCounter(
      WEBHOOK_QUEUE_SHED_TOTAL,
      { endpoint: endpointId },
      1,
      'Total webhook deliveries deferred due to queue depth limit',
    );
  }

  /**
   * Attempt delivery of a webhook payload to an active endpoint.
   *
   * @dev Back-pressure contract: when the bounded queue is at capacity the
   *      delivery is persisted with status 'deferred' (never dropped) and the
   *      webhook_queue_shed_total counter is incremented exactly once per
   *      status transition. When a retry is re-enqueued with `deliveryId`, the
   *      same row is deferred instead of a duplicate being inserted, so retries
   *      are idempotent and preserve the attempt counter.
   * @param url        Webhook endpoint URL (SSRF validation precedes any write)
   * @param payload    Event payload to deliver
   * @param deliveryId Existing delivery row to reuse (retry path)
   * @returns true when delivered, false when deferred/failed/absent endpoint
   */
  static async processDelivery(
    url: string,
    payload: any,
    deliveryId?: string,
  ): Promise<boolean> {
    if (!this.repo || !this.service) {
      console.error("[WebhookQueue] Not initialized");
      return false;
    }

    if (!(await this.isSafeUrl(url))) {
      console.error(`[Security] Blocked unsafe webhook URL: ${url}`);
      return false;
    }

    const endpoint = await this.repo.findByUrl(url);
    if (!endpoint) {
      console.error(`[WebhookQueue] No active endpoint found for URL: ${url}`);
      return false;
    }

    // --- Back-pressure: defer when at capacity ---
    if (this.inFlight >= this.maxDepth) {
      // When a retry is re-enqueued (deliveryId known), defer that same row
      // instead of inserting a duplicate so attempts/backoff state are kept and
      // the shed counter stays idempotent across retries of the same delivery.
      let deferred: WebhookDelivery | null = deliveryId
        ? await this.repo.findDeliveryById(deliveryId)
        : null;

      let deferredId: string;
      if (!deferred) {
        deferred = await this.repo.createDelivery({
          endpoint_id: endpoint.id,
          payload,
          status: 'deferred',
          attempts: 0,
        });
        deferredId = deferred.id;
        this.recordShed(endpoint.id);
      } else {
        deferredId = deferred.id;
        if (deferred.status !== 'deferred') {
          await this.repo.updateDelivery(deferred.id, {
            status: 'deferred',
          });
          this.recordShed(endpoint.id);
        }
      }

      globalMetrics.setGauge(
        WEBHOOK_QUEUE_DEPTH_GAUGE,
        this.inFlight,
        {},
        'Current in-flight webhook deliveries when the queue sheds a delivery',
      );
      console.warn(
        `[WebhookQueue] Queue full (${this.inFlight}/${this.maxDepth}), deferred delivery ${deferredId}`,
      );
      return false;
    }

    let delivery: WebhookDelivery | null = null;
    if (deliveryId) delivery = await this.repo.findDeliveryById(deliveryId);

    if (!delivery) {
      delivery = await this.repo.createDelivery({
        endpoint_id: endpoint.id,
        payload,
        status: "pending",
        attempts: 0,
      });
    }

    this.inFlight++;
    try {
      return await this._attempt(endpoint, delivery, payload);
    } finally {
      this.inFlight--;
    }
  }

  private static async _attempt(
    endpoint: { id: string; url: string; secret: string },
    delivery: WebhookDelivery,
    payload: any,
  ): Promise<boolean> {
    const currentAttempt = delivery.attempts + 1;

    // Propagate the transactional outbox event_id when present (idempotency key
    // the receiver's webhookEventOrdering relies on to deduplicate retries), and
    // fall back to the delivery row id for legacy callers.
    const webhookPayload: WebhookPayload = {
      id: (payload?.id as string) || delivery.id,
      event: (payload as any).event || WebhookEventType.OFFERING_UPDATED,
      payload: (payload as any).payload || payload,
      timestamp: new Date().toISOString(),
    };

    const result = await this.service.sendAttempt(
      { id: endpoint.id, url: endpoint.url, secret: endpoint.secret },
      webhookPayload,
    );

    if (result.success) {
      await this.repo.updateDelivery(delivery.id, {
        status: "completed",
        attempts: currentAttempt,
        last_error: null,
        next_retry_at: null,
      });
      return true;
    }

    const isRetryable =
      !result.statusCode ||
      result.statusCode >= 500 ||
      result.statusCode === 429;
    const nextDelay = this.getBackoffDelay(currentAttempt);

    if (isRetryable && nextDelay !== -1) {
      const nextRetryAt = new Date(Date.now() + nextDelay);
      await this.repo.updateDelivery(delivery.id, {
        attempts: currentAttempt,
        last_error: result.error,
        next_retry_at: nextRetryAt,
      });

      setTimeout(() => {
        void this.processDelivery(endpoint.url, payload, delivery.id);
      }, nextDelay);

      return false;
    }

    await this.repo.updateDelivery(delivery.id, {
      status: nextDelay === -1 ? "dead_letter" : "failed",
      attempts: currentAttempt,
      last_error: result.error,
      next_retry_at: null,
    });

    if (nextDelay === -1) {
      try {
        const count = await this.repo.countDeadLettersByEndpoint(delivery.endpoint_id);
        globalMetrics.setGauge(
          'webhook_dead_letter_total',
          count,
          { endpoint: endpoint.id },
          'Number of dead-lettered webhook deliveries per endpoint',
        );
      } catch (err) {
        console.error('[WebhookQueue] Failed to update dead-letter metric:', err);
      }
    }
    return false;
  }

  static async resumePending(): Promise<void> {
    if (!this.repo) return;
    const pending = await this.repo.getPendingDeliveries();
    for (const delivery of pending) {
      // Honour the same bounded-depth contract as resumeDeferred; excess rows
      // stay pending and are picked up on the next resume cycle.
      if (this.inFlight >= this.maxDepth) break;
      const endpoint = await this.repo.findById(delivery.endpoint_id);
      if (endpoint) {
        void this.processDelivery(endpoint.url, delivery.payload, delivery.id);
      }
    }
  }

  /**
   * Re-enqueue deferred deliveries up to available capacity.
   * Safe to call repeatedly; excess deferred rows remain deferred.
   */
  static async resumeDeferred(): Promise<void> {
    if (!this.repo) return;
    const deferred = await this.repo.getDeferredDeliveries();
    for (const delivery of deferred) {
      if (this.inFlight >= this.maxDepth) break;
      const endpoint = await this.repo.findById(delivery.endpoint_id);
      if (!endpoint) continue;
      // Promote back to pending so processDelivery can pick it up
      await this.repo.updateDelivery(delivery.id, { status: 'pending' });
      void this.processDelivery(endpoint.url, delivery.payload, delivery.id);
    }
  }
}

/**
 * Build a PayoutDriftDetector, injecting a StellarTransactionVerifier when
 * STELLAR_HORIZON_URL is configured. Logs a startup warning and sets the
 * payout_drift_verifier_enabled gauge to 0 when it is not configured.
 */
export function createPayoutDriftDetector(
  pool: Pool,
  driftRepo: PayoutDriftRepository,
  metrics: MetricsCollector,
): PayoutDriftDetector {
  const configured = Boolean(process.env.STELLAR_HORIZON_URL);
  const txVerifier: StellarTransactionVerifier | undefined = configured
    ? createStellarTransactionVerifier()
    : undefined;

  if (!configured) {
    globalLogger.warn('PayoutDriftDetector: no STELLAR_HORIZON_URL configured; under/overfunded drift will not be detected');
    globalMetrics.setGauge(
      'payout_drift_verifier_enabled',
      0,
      {},
      '1 when a StellarTransactionVerifier is configured for payout drift detection'
    );
  } else {
    globalMetrics.setGauge('payout_drift_verifier_enabled', 1, {});
  }

  return new PayoutDriftDetector(pool, driftRepo, metrics, txVerifier);
}

/* istanbul ignore next -- bootstrapping is integration-environment specific */
if (require.main === module && env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  const backgroundStopFns: (() => void)[] = [];

  // Resolve worker role — fail-fast on invalid value
  const { resolveWorkerRole, getRoleConfig } = require("./config/workerRole");
  const workerRole = resolveWorkerRole(env.ROLE, env.NODE_ENV);
  const roleConfig = getRoleConfig(workerRole);
  console.log(`[server] Starting with role="${workerRole}"`, roleConfig);

  const metricsCollector = new MetricsCollector();

  const unconditionalPayoutDriftDetector = createPayoutDriftDetector(
    pool,
    new PayoutDriftRepository(pool),
    metricsCollector
  );
  unconditionalPayoutDriftDetector.start(); // Start nightly payout drift detection
  globalSampler.start(); // Start event loop lag monitoring

  if (roleConfig.auditPurge) {
    const auditLogRepo = new AuditLogRepository(pool);
    const auditPurgeService = new AuditPurgeService(auditLogRepo, metricsCollector);
    auditPurgeService.start();
    backgroundStopFns.push(() => auditPurgeService.stop());
    console.log("[server] AuditPurgeService started");
  }

  if (roleConfig.auditPurge) { // Reusing auditPurge role for general cleanup tasks
    const sessionRepo = new SessionRepository(pool);
    const sessionCompactionService = new SessionCompactionService(sessionRepo, metricsCollector);
    sessionCompactionService.start();
    backgroundStopFns.push(() => sessionCompactionService.stop());
    console.log("[server] SessionCompactionService started");
  }

  if (roleConfig.payoutDrift) {
    const payoutDriftRepo = new PayoutDriftRepository(pool);
    const payoutDriftDetector = createPayoutDriftDetector(
      pool,
      payoutDriftRepo,
      metricsCollector
    );
    payoutDriftDetector.start();
    backgroundStopFns.push(() => payoutDriftDetector.stop());
    console.log("[server] PayoutDriftDetector started");
  }

  if (roleConfig.reconciliation) {
    // Build a StellarTransactionVerifier from the configured Horizon URL so that
    // chain consistency checks can validate distribution transactions on-chain.
    // When STELLAR_HORIZON_URL is absent the verifier falls back to the testnet
    // endpoint; chain validation is still skipped with a single warning discrepancy
    // if the verifier cannot be constructed.
    const txVerifier = new StellarTransactionVerifierImpl({
      horizonUrl: env.STELLAR_HORIZON_URL,
    });
    const reconciliationScheduler = createReconciliationSchedulerRuntime({
      db: pool,
      metrics: globalMetrics,
      logger: undefined,
      txVerifier,
    });
    reconciliationScheduler.start();
    backgroundStopFns.push(() => reconciliationScheduler.stop());
    console.log("[server] ReconciliationScheduler started");
  }

  // --- Hot-path services (only for "api" and "all" roles) ---

  if (roleConfig.webhookQueue) {
    const repo = new WebhookEndpointRepository(pool);
    const service = new WebhookService(repo, {
      outboxRepo: env.OUTBOX_DISPATCHER_ENABLED ? new OutboxRepository(pool) : undefined,
    });
    WebhookQueue.init(repo, service);
    void WebhookQueue.resumePending();
    console.log("[server] WebhookQueue started");

    // Drain the transactional outbox in a separate polling worker. Every
    // outbox row was written atomically with the transaction that produced
    // the event; retries reuse the same event_id so receivers can deduplicate
    // via webhookEventOrdering (exactly-once).
    if (env.OUTBOX_DISPATCHER_ENABLED) {
      const outboxRepo = new OutboxRepository(pool);
      const dispatcher = new OutboxDispatcher(
        outboxRepo,
        makeWebhookDispatchFn(
          WebhookQueue.processDelivery.bind(WebhookQueue),
          (event) => repo.listActiveByEvent(event),
        ),
      );
      dispatcher.start();
      backgroundStopFns.push(() => dispatcher.stop());
      console.log("[server] OutboxDispatcher started");
    }
  }

  for (const stopFn of backgroundStopFns) {
    process.on("SIGTERM", stopFn);
    process.on("SIGINT", stopFn);
  }

  // --- HTTP server (only for "api" and "all" roles) ---

  if (roleConfig.httpServer) {
    server = app.listen(port, () => {
      console.log(`revora-backend listening on http://localhost:${port} (role=${workerRole})`);
    });
  } else {
    console.log(`[server] HTTP server disabled for role="${workerRole}". Running background workers only.`);
  }
}

export default app;
