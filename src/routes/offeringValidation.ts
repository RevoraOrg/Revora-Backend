import {
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from "express";
import { Errors } from "../lib/errors";
import { offeringSanitizeMiddleware } from "../middleware/offeringSanitize";

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

export type OfferingActorRole = (typeof OFFERING_ROLES)[number];
export type OfferingValidationAction = (typeof OFFERING_ACTIONS)[number];
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];
type DecisionSeverity = "error" | "warning";

export interface AuthenticatedUser {
  id: string;
  role: OfferingActorRole;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export interface OfferingValidationPayload {
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

export interface ValidationCheck {
  code: string;
  passed: boolean;
  severity: DecisionSeverity;
  message: string;
}

export interface OfferingValidationResult {
  allowed: boolean;
  decision: "allow" | "deny";
  action: OfferingValidationAction;
  actor: AuthenticatedUser;
  offeringId: string | null;
  checks: ValidationCheck[];
  violations: ValidationCheck[];
  securityAssumptions: readonly string[];
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

export function isOfferingRole(value: unknown): value is OfferingActorRole {
  return (
    typeof value === "string" &&
    (OFFERING_ROLES as readonly string[]).includes(value)
  );
}

export function isOfferingAction(
  value: unknown,
): value is OfferingValidationAction {
  return (
    typeof value === "string" &&
    (OFFERING_ACTIONS as readonly string[]).includes(value)
  );
}

export function isOfferingStatus(value: unknown): value is OfferingStatus {
  return (
    typeof value === "string" &&
    (OFFERING_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * @dev Decimal parser with strict input bounds to resist coercion abuse and NaN payloads.
 */
export function parseMoneyString(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

export function parseIsoDate(value: unknown): Date | null {
  if (!isNonEmptyString(value, 64)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function requireOfferingAuth(
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

export function parseOfferingValidationPayload(
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
    payload.offering.status = offeringRecord.status;
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

export function evaluateOfferingValidationMatrix(
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

export function createOfferingValidationHandler(
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

export function createOfferingValidationRouter(): Router {
  const router = Router();
  router.post(
    "/validation-matrix",
    requireOfferingAuth,
    offeringSanitizeMiddleware,
    createOfferingValidationHandler(),
  );
  return router;
}
