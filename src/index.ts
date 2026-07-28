import "dotenv/config";
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
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "./lib/stellarRpcFailure";
import { createHealthRouter } from "./routes/health";
import vestingRouter from "./routes/vesting";
import { offeringSanitizeMiddleware } from "./middleware/offeringSanitize";
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
import { pool } from "./db/pool";
import { globalMetrics } from "./lib/metrics";
import { createPasswordResetRouter } from "./routes/passwordReset";
import { emailService } from "./services/emailService";
import { EmailDeliverabilityService } from "./services/emailDeliverabilityService";
import { EmailDeliverabilityRepository } from "./db/repositories/emailDeliverabilityRepository";
import { createEmailWebhooksRouter } from "./routes/emailWebhooks";
import { createAdminRouter } from "./routes/admin";
import { createAdminKycRiskTierRouter } from "./routes/adminKycRiskTier";
import { AuditLogRepository } from "./db/repositories/auditLogRepository";
import { TenantSettingsRepository } from "./db/repositories/tenantSettingsRepository";
import { ContractUpgradeOrchestratorService } from "./services/contractUpgradeOrchestratorService";
import { createContractUpgradeRouter } from "./routes/contractUpgradeRoutes";
import { AuditPurgeService } from "./services/auditPurgeService";
import { RetentionLabelRepository } from "./db/repositories/retentionLabelRepository";
import { RetentionLabelService } from "./services/retentionLabelService";
import { PayoutDriftRepository } from "./db/repositories/payoutDriftRepository";
import { PayoutDriftDetector } from "./services/payoutDriftDetector";
import { MetricsCollector } from "./lib/metrics";
import { createAMLRoutes } from "./routes/amlRoutes";
import { createAMLService } from "./aml/amlService";
import { InMemorySecurityAuditRepository } from "./security/audit";
import { createMobileCompanionRouter } from "./routes/mobileCompanion";
import { InMemoryDeviceKeyStore } from "./middleware/deviceSignature";
import { Keypair } from '@stellar/stellar-sdk';

const port = env.PORT;
const API_VERSION_PREFIX = env.API_VERSION_PREFIX;

const OFFERING_ROLES = ["startup", "admin", "compliance", "investor"] as const;
const OFFERING_ACTIONS = [
  "create",
  "update",
  "publish",
  "pause",
  "close",
  "cancel",
  "viewPrivate",
  "invest",
] as const;
const OFFERING_STATUSES = [
  "draft",
  "open",
  "paused",
  "closed",
  "cancelled",
  "completed",
] as const;
const OFFERING_SECURITY_ASSUMPTIONS = [
  "Caller identity is asserted by trusted upstream auth middleware before these rules are used for authorization.",
  "Money amounts are decimal strings to avoid binary rounding; invalid or unbounded numeric input is rejected.",
  "Startup actors may only manage offerings they issued unless a privileged admin or compliance actor performs the action.",
  "Validation output is safe for clients and never includes raw database, token, or upstream provider error messages.",
] as const;

type OfferingActorRole = (typeof OFFERING_ROLES)[number];
type OfferingValidationAction = (typeof OFFERING_ACTIONS)[number];
type OfferingStatus = (typeof OFFERING_STATUSES)[number];
type DecisionSeverity = "error" | "warning";

interface AuthenticatedUser {
  id: string;
  role: OfferingActorRole;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

interface AppDependencies {
  healthQuery?: typeof dbQuery;
  healthStatus?: typeof dbHealth;
}

interface OfferingValidationPayload {
  action: OfferingValidationAction;
  offering: {
    id?: string;
    issuerId?: string;
    status?: OfferingStatus;
    targetAmount?: string;
    minimumInvestment?: string;
    investmentAmount?: string;
    subscriptionStartsAt?: string;
    subscriptionEndsAt?: string;
  };
}

interface ValidationCheck {
  code: string;
  passed: boolean;
  severity: DecisionSeverity;
  message: string;
}

interface OfferingValidationResult {
  allowed: boolean;
  decision: "allow" | "deny";
  action: OfferingValidationAction;
  actor: AuthenticatedUser;
  offeringId: string | null;
  checks: ValidationCheck[];
  violations: ValidationCheck[];
  securityAssumptions: readonly string[];
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

function isOfferingRole(value: unknown): value is OfferingActorRole {
  return (
    typeof value === "string" &&
    (OFFERING_ROLES as readonly string[]).includes(value)
  );
}

function isOfferingAction(value: unknown): value is OfferingValidationAction {
  return (
    typeof value === "string" &&
    (OFFERING_ACTIONS as readonly string[]).includes(value)
  );
}

function isOfferingStatus(value: unknown): value is OfferingStatus {
  return (
    typeof value === "string" &&
    (OFFERING_STATUSES as readonly string[]).includes(value)
  );
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

/**
 * @dev Decimal parser with strict input bounds to resist coercion abuse and NaN payloads.
 */
function parseMoneyString(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseIsoDate(value: unknown): Date | null {
  if (!isNonEmptyString(value, 64)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
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

function requireOfferingAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const userId = req.header("x-user-id");
  const role = req.header("x-user-role");

  if (!isNonEmptyString(userId) || !isOfferingRole(role)) {
    next(
      Errors.unauthorized(
        "Offering validation requires x-user-id and x-user-role headers",
      ),
    );
    return;
  }

  (req as AuthenticatedRequest).user = { id: userId.trim(), role };
  next();
}

function parseOfferingValidationPayload(
  body: unknown,
): OfferingValidationPayload {
  if (!body || typeof body !== "object") {
    throw Errors.badRequest("Validation payload must be a JSON object");
  }

  const raw = body as Record<string, unknown>;
  if (!isOfferingAction(raw.action)) {
    throw Errors.badRequest("Invalid offering validation action", {
      allowedActions: OFFERING_ACTIONS,
    });
  }

  const rawOffering = raw.offering;
  if (!rawOffering || typeof rawOffering !== "object") {
    throw Errors.badRequest(
      "Offering validation payload must include an offering object",
    );
  }

  const offeringRecord = rawOffering as Record<string, unknown>;
  const payload: OfferingValidationPayload = {
    action: raw.action,
    offering: {},
  };

  if (offeringRecord.id !== undefined) {
    if (!isNonEmptyString(offeringRecord.id)) {
      throw Errors.badRequest("offering.id must be a non-empty string");
    }
    payload.offering.id = offeringRecord.id.trim();
  }

  if (offeringRecord.issuerId !== undefined) {
    if (!isNonEmptyString(offeringRecord.issuerId)) {
      throw Errors.badRequest("offering.issuerId must be a non-empty string");
    }
    payload.offering.issuerId = offeringRecord.issuerId.trim();
  }

  if (offeringRecord.status !== undefined) {
    if (!isOfferingStatus(offeringRecord.status)) {
      throw Errors.badRequest(
        "offering.status must be a supported offering status",
        {
          allowedStatuses: OFFERING_STATUSES,
        },
      );
    }
    payload.offering.status = offeringRecord.status as OfferingStatus;
  }

  const stringFields: Array<
    | "targetAmount"
    | "minimumInvestment"
    | "investmentAmount"
    | "subscriptionStartsAt"
    | "subscriptionEndsAt"
  > = [
    "targetAmount",
    "minimumInvestment",
    "investmentAmount",
    "subscriptionStartsAt",
    "subscriptionEndsAt",
  ];

  for (const field of stringFields) {
    const value = offeringRecord[field];
    if (value !== undefined) {
      if (!isNonEmptyString(value, 64)) {
        throw Errors.badRequest(`offering.${field} must be a non-empty string`);
      }
      payload.offering[field] = value.trim();
    }
  }

  return payload;
}

function evaluateOfferingValidationMatrix(
  actor: AuthenticatedUser,
  payload: OfferingValidationPayload,
  now = new Date(),
): OfferingValidationResult {
  const checks: ValidationCheck[] = [];
  const { action, offering } = payload;

  const addCheck = (
    code: string,
    passed: boolean,
    message: string,
    severity: DecisionSeverity = "error",
  ): void => {
    checks.push({ code, passed, message, severity });
  };

  const isPrivileged = actor.role === "admin" || actor.role === "compliance";
  const isStartup = actor.role === "startup";
  const isInvestor = actor.role === "investor";
  const managesOffering = action !== "invest";
  const issuerKnown = typeof offering.issuerId === "string";
  const ownsOffering = issuerKnown && offering.issuerId === actor.id;
  const targetAmount = parseMoneyString(offering.targetAmount);
  const minimumInvestment = parseMoneyString(offering.minimumInvestment);
  const investmentAmount = parseMoneyString(offering.investmentAmount);
  const subscriptionStartsAt = parseIsoDate(offering.subscriptionStartsAt);
  const subscriptionEndsAt = parseIsoDate(offering.subscriptionEndsAt);

  addCheck(
    "ROLE_ALLOWED_FOR_ACTION",
    isPrivileged ||
      (isStartup &&
        [
          "create",
          "update",
          "publish",
          "pause",
          "close",
          "cancel",
          "viewPrivate",
        ].includes(action)) ||
      (isInvestor && action === "invest"),
    `${actor.role} may not perform ${action} for offering workflows`,
  );

  if (managesOffering) {
    addCheck(
      "OWNERSHIP_CONFIRMED",
      isPrivileged || action === "create" || !issuerKnown || ownsOffering,
      "Offering management requires issuer ownership unless actor is privileged",
    );
  }

  if (["create", "update", "publish"].includes(action)) {
    addCheck(
      "TARGET_AMOUNT_VALID",
      targetAmount !== null && targetAmount > 0,
      "targetAmount must be a positive decimal string with up to 2 fractional digits",
    );

    addCheck(
      "MINIMUM_INVESTMENT_VALID",
      minimumInvestment !== null && minimumInvestment > 0,
      "minimumInvestment must be a positive decimal string with up to 2 fractional digits",
    );

    if (targetAmount !== null && minimumInvestment !== null) {
      addCheck(
        "MINIMUM_NOT_GREATER_THAN_TARGET",
        minimumInvestment <= targetAmount,
        "minimumInvestment cannot exceed targetAmount",
      );
    }
  }

  if (action === "publish") {
    addCheck(
      "STATUS_ELIGIBLE_FOR_PUBLISH",
      offering.status === "draft",
      "Only draft offerings may be published",
    );
    addCheck(
      "SUBSCRIPTION_START_VALID",
      subscriptionStartsAt !== null,
      "subscriptionStartsAt must be a valid ISO-8601 date",
    );
    addCheck(
      "SUBSCRIPTION_END_VALID",
      subscriptionEndsAt !== null,
      "subscriptionEndsAt must be a valid ISO-8601 date",
    );

    if (subscriptionStartsAt && subscriptionEndsAt) {
      addCheck(
        "SUBSCRIPTION_WINDOW_ORDERED",
        subscriptionEndsAt.getTime() > subscriptionStartsAt.getTime(),
        "subscriptionEndsAt must be later than subscriptionStartsAt",
      );
      addCheck(
        "SUBSCRIPTION_ENDS_IN_FUTURE",
        subscriptionEndsAt.getTime() > now.getTime(),
        "subscriptionEndsAt must be in the future when publishing",
      );
    }
  }

  if (action === "pause") {
    addCheck(
      "STATUS_ELIGIBLE_FOR_PAUSE",
      offering.status === "open",
      "Only open offerings may be paused",
    );
  }

  if (action === "close") {
    addCheck(
      "STATUS_ELIGIBLE_FOR_CLOSE",
      offering.status === "open" || offering.status === "paused",
      "Only open or paused offerings may be closed",
    );
  }

  if (action === "cancel") {
    addCheck(
      "STATUS_ELIGIBLE_FOR_CANCEL",
      offering.status === "draft" ||
        offering.status === "open" ||
        offering.status === "paused",
      "Only draft, open, or paused offerings may be cancelled",
    );
  }

  if (action === "viewPrivate") {
    addCheck(
      "PRIVATE_VIEW_ALLOWED",
      isPrivileged || (isStartup && (!issuerKnown || ownsOffering)),
      "Private offering details are limited to privileged actors and the issuer",
    );
  }

  if (action === "invest") {
    addCheck(
      "STATUS_OPEN_FOR_INVESTMENT",
      offering.status === "open",
      "Investments are accepted only while an offering is open",
    );
    addCheck(
      "INVESTMENT_AMOUNT_VALID",
      investmentAmount !== null && investmentAmount > 0,
      "investmentAmount must be a positive decimal string with up to 2 fractional digits",
    );

    if (minimumInvestment !== null && investmentAmount !== null) {
      addCheck(
        "INVESTMENT_MEETS_MINIMUM",
        investmentAmount >= minimumInvestment,
        "investmentAmount must be greater than or equal to minimumInvestment",
      );
    }

    if (targetAmount !== null && investmentAmount !== null) {
      addCheck(
        "INVESTMENT_WITHIN_TARGET",
        investmentAmount <= targetAmount,
        "investmentAmount cannot exceed targetAmount for a single validation request",
        "warning",
      );
    }

    addCheck(
      "INVESTOR_NOT_ISSUER",
      !issuerKnown || offering.issuerId !== actor.id,
      "Issuer self-investment is blocked by default pending explicit compliance approval",
    );

    if (subscriptionStartsAt && subscriptionEndsAt) {
      addCheck(
        "INVESTMENT_WINDOW_ACTIVE",
        now.getTime() >= subscriptionStartsAt.getTime() &&
          now.getTime() <= subscriptionEndsAt.getTime(),
        "Investments must occur within the subscription window",
      );
    } else {
      addCheck(
        "INVESTMENT_WINDOW_ACTIVE",
        false,
        "subscriptionStartsAt and subscriptionEndsAt are required to validate investments",
      );
    }
  }

  const violations = checks.filter((check) => !check.passed);
  return {
    allowed: violations.length === 0,
    decision: violations.length === 0 ? "allow" : "deny",
    action,
    actor,
    offeringId: offering.id ?? null,
    checks,
    violations,
    securityAssumptions: OFFERING_SECURITY_ASSUMPTIONS,
  };
}

function createOfferingValidationHandler(
  nowProvider: () => Date = () => new Date(),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const actor = (req as AuthenticatedRequest).user;
      /* istanbul ignore next -- guarded by requireOfferingAuth middleware */
      if (!actor) {
        next(Errors.unauthorized("Authenticated offering actor is required"));
        return;
      }

      const payload = parseOfferingValidationPayload(req.body);
      const result = evaluateOfferingValidationMatrix(
        actor,
        payload,
        nowProvider(),
      );

      res.status(result.allowed ? 200 : 422).json(result);
    } catch (error) {
      next(error);
    }
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
    const region = env.REGION;
    const activeRegion = env.FAILOVER_ACTIVE_REGION ?? region;
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

  apiRouter.post(
    "/offerings/validation-matrix",
    requireOfferingAuth,
    offeringSanitizeMiddleware,
    createOfferingValidationHandler(),
  );

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
  const retentionLabelService = new RetentionLabelService(
    new RetentionLabelRepository(pool),
    auditLogRepo,
  );
  const tenantSettingsRepo = new TenantSettingsRepository(pool);
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

  if (contractUpgradeService) {
    apiRouter.use(
      "/contract-upgrades",
      createContractUpgradeRouter(contractUpgradeService),
    );
  }

  // Initialize AML service and routes
  const amlService = createAMLService(pool, amlAuditRepo, 'system');
  apiRouter.use("/aml", createAMLRoutes(amlService));

  // Mobile companion API with per-device Ed25519 request signatures
  const deviceKeyStore = new InMemoryDeviceKeyStore();
  apiRouter.use("/mobile", createMobileCompanionRouter({ keyStore: deviceKeyStore }));

  app.use(API_VERSION_PREFIX, apiRouter);
  app.use((_req, _res, next) => next(Errors.notFound("Route not found")));
  app.use(errorHandler);

  return app;
}

export const __test = {
  stableSerialize,
  parseMoneyString,
  parseIsoDate,
  parseOfferingValidationPayload,
  evaluateOfferingValidationMatrix,
  /**
   * @dev Exposes the tier-limiter factory for integration tests that need to
   *      inspect tier resolution or reset counters without restarting the app.
   */
  createStartupAuthTierLimiter,
};

export { classifyStellarRPCFailure, StellarRPCFailureClass };

export const app = createApp();

let isShuttingDown = false;

/* istanbul ignore next -- exercised only in real process shutdown */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

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
 *         is available.
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
      const deferred = await this.repo.createDelivery({
        endpoint_id: endpoint.id,
        payload,
        status: 'deferred',
        attempts: 0,
      });
      globalMetrics.incrementCounter(
        'webhook_queue_shed_total',
        { endpoint: endpoint.id },
        1,
        'Total webhook deliveries deferred due to queue depth limit',
      );
      console.warn(
        `[WebhookQueue] Queue full (${this.inFlight}/${this.maxDepth}), deferred delivery ${deferred.id}`,
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

    const webhookPayload: WebhookPayload = {
      id: delivery.id,
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

/* istanbul ignore next -- bootstrapping is integration-environment specific */
if (require.main === module && env.NODE_ENV !== "test") {
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  // Resolve worker role — fail-fast on invalid value
  const { resolveWorkerRole, getRoleConfig } = require("./config/workerRole");
  const workerRole = resolveWorkerRole(env.ROLE, env.NODE_ENV);
  const roleConfig = getRoleConfig(workerRole);
  console.log(`[server] Starting with role="${workerRole}"`, roleConfig);

  const metricsCollector = new MetricsCollector();

  // --- Batch / background services (only for "batch" and "all" roles) ---
  const backgroundStopFns: Array<() => void> = [];

  if (roleConfig.auditPurge) {
    const auditLogRepo = new AuditLogRepository(pool);
    const auditPurgeService = new AuditPurgeService(auditLogRepo, metricsCollector);
    auditPurgeService.start();
    backgroundStopFns.push(() => auditPurgeService.stop());
    console.log("[server] AuditPurgeService started");
  }

  if (roleConfig.payoutDrift) {
    const payoutDriftRepo = new PayoutDriftRepository(pool);
    const payoutDriftDetector = new PayoutDriftDetector(
      pool,
      payoutDriftRepo,
      metricsCollector,
    );
    payoutDriftDetector.start();
    backgroundStopFns.push(() => payoutDriftDetector.stop());
    console.log("[server] PayoutDriftDetector started");
  }

  // --- Hot-path services (only for "api" and "all" roles) ---

  if (roleConfig.webhookQueue) {
    const repo = new WebhookEndpointRepository(pool);
    const service = new WebhookService(repo);
    WebhookQueue.init(repo, service);
    void WebhookQueue.resumePending();
    console.log("[server] WebhookQueue started");
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
