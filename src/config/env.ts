import "dotenv/config";
import { z } from "zod";

/**
 * Boolean environment flag parsing.
 *
 * SECURITY CONTEXT (issue #1305):
 * `z.coerce.boolean()` applies JavaScript `Boolean(value)`, so every
 * non-empty string — including `"false"`, `"0"` and `"no"` — coerces to
 * `true`. An operator who set `OUTBOX_DISPATCHER_ENABLED=false` silently got
 * the outbox dispatcher started, and `EMAIL_DELIVERABILITY_ENABLED=false`
 * still mounted the SendGrid/SES/SMTP webhook routes. Kill switches that
 * cannot be switched off are a security-relevant failure mode, so boolean
 * flags are parsed from an explicit value set instead.
 *
 * Accepted values (case-insensitive, surrounding whitespace ignored):
 * - Truthy:  `true`, `1`, `yes`, `on`
 * - Falsy:   `false`, `0`, `no`, `off`
 *
 * Security assumptions:
 * - An unset variable falls back to the caller-provided default.
 * - An empty string is rejected with a clear validation error (it used to
 *   coerce to `false` under `Boolean()`, which masked operator typos).
 * - Anything outside the accepted set fails validation at startup rather
 *   than silently enabling or disabling a feature.
 */
const TRUE_FLAG_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_FLAG_VALUES = new Set(["false", "0", "no", "off"]);
const BOOLEAN_FLAG_VALUES = "true, false, 1, 0, yes, no, on, off";

/**
 * Zod schema factory for boolean environment flags.
 *
 * Use in place of `z.coerce.boolean()` (which treats `"false"` as `true`):
 *
 * ```ts
 * MY_FEATURE_ENABLED: envBoolean(false), // default: disabled
 * ```
 *
 * @param defaultValue - Value used when the variable is unset.
 * @returns Zod schema producing a `boolean`.
 */
export function envBoolean(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (TRUE_FLAG_VALUES.has(normalized)) return true;
      if (FALSE_FLAG_VALUES.has(normalized)) return false;
      ctx.addIssue({
        code: "custom",
        message: `must be one of: ${BOOLEAN_FLAG_VALUES} (case-insensitive)`,
      });
      return z.NEVER;
    });
}

/**
 * Reads a boolean flag directly from `process.env` at call time.
 *
 * For ad-hoc reads that intentionally bypass the startup schema (e.g.
 * middleware that is constructed per request or per test). Shares the same
 * accepted value set as {@link envBoolean}; invalid values throw a clear
 * error instead of silently coercing.
 *
 * @param name - Environment variable name (used in the error message).
 * @param defaultValue - Value used when the variable is unset.
 * @throws Error when the variable is set to a value outside the accepted set.
 */
export function readEnvBoolean(name: string, defaultValue: boolean): boolean {
  const parsed = envBoolean(defaultValue).safeParse(process.env[name]);
  if (parsed.success) return parsed.data;
  throw new Error(
    `${name} must be one of: ${BOOLEAN_FLAG_VALUES} (case-insensitive)`,
  );
}

/**
 * Environment Configuration
 * 
 * | Variable                    | Required | Default                 | Description                                      |
 * |-----------------------------|----------|-------------------------|--------------------------------------------------|
 * | NODE_ENV                    | No       | development             | Runtime environment (development, test, prod)    |
 * | PORT                        | No       | 4000                    | Port for the Express server to listen on         |
 * | API_VERSION_PREFIX          | No       | /api/v1                 | Prefix for API routes                            |
 * | DATABASE_URL                | Yes/Prod | (empty)                 | Connection string for the PostgreSQL database    |
 * | JWT_SECRET                  | Yes/Prod | (empty)                 | Secret key for signing JSON Web Tokens           |
 * | JWT_SECRET_PREVIOUS         | No       | (empty)                 | Previous secret key for graceful token rotation  |
 * | JWT_KEY_ID                  | No       | (empty)                 | Key ID for current JWT secret (kid header)      |
 * | JWT_PREVIOUS_KEY_ID         | No       | (empty)                 | Key ID for previous JWT secret (kid header)     |
 * | JWT_ISSUER                  | No       | (empty)                 | Issuer claim (iss) to set in issued tokens       |
 * | JWT_AUDIENCE                | No       | (empty)                 | Audience claim (aud) to set in issued tokens     |
 * | JWT_CLOCK_TOLERANCE_SECONDS | No       | (empty)                 | Clock tolerance in seconds for JWT verification  |
 * | STELLAR_NETWORK             | No       | testnet                 | Stellar network to connect to (public, testnet)  |
 * | STELLAR_HORIZON_URL         | No       | (network default)       | URL of the Stellar Horizon server                |
 * | STELLAR_NETWORK_PASSPHRASE  | No       | (network default)       | Passphrase of the Stellar network                |
 * | STELLAR_SERVER_SECRET       | Yes      | (empty)                 | Secret key of the Stellar server account         |
 * | STELLAR_TIMEOUT             | No       | 30000                   | Timeout in ms for Stellar operations             |
 * | STELLAR_MAX_FEE             | No       | 100000                  | Maximum fee in stroops for Stellar transactions  |
 * | ALLOWED_ORIGINS             | No       | localhost:3000          | Comma-separated list of allowed CORS origins     |
 * | AUDIT_RETENTION_DAYS        | No       | 90                      | Number of days to retain audit logs              |
 * | AUDIT_EXPORT_SIGNING_KEY    | Yes/Prod | (empty)                 | Base64-encoded Ed25519 private key (32-byte seed) for signing audit CSV exports |
 * | AUDIT_EXPORT_PUBLIC_KEY     | No       | (empty)                 | Base64-encoded Ed25519 public key, documented so auditors can verify exports offline |
 * | SESSION_RETENTION_DAYS      | No       | 30                      | Number of days to retain expired/revoked sessions|
 * | EMAIL_PROVIDER              | No       | mock/sendgrid           | Email provider: sendgrid, smtp, or mock          |
 * | FROM_EMAIL                  | No       | noreply@revora.com      | Default sender address for transactional email   |
 * | SENDGRID_API_KEY            | SendGrid | (empty)                 | SendGrid API key                                 |
 * | SMTP_HOST                   | SMTP     | (empty)                 | SMTP relay host                                  |
 * | SMTP_PORT                   | SMTP     | 587                     | SMTP relay port                                  |
 * | SMTP_USER                   | No       | (empty)                 | SMTP username; sent only after STARTTLS          |
 * | SMTP_PASS                   | No       | (empty)                 | SMTP password; sent only after STARTTLS          |
 * | CURSOR_SIGNING_SECRET       | No       | dev-cursor-secret...    | Secret for HMAC-signed opaque pagination cursors |
 * | REGION                      | No       | us-east-1               | Current region identifier for multi-region setup |
 * | FAILOVER_ACTIVE_REGION      | No       | (REGION value)          | Region currently serving as active failover      |
 * | EMAIL_DELIVERABILITY_ENABLED| No       | true                    | Enable email deliverability tracking; accepts true/false/1/0/yes/no/on/off |
 * | SENDGRID_EVENT_WEBHOOK_SECRET| No      | (empty)                 | Secret for SendGrid event webhook verification   |
 * | SES_SNS_TOPIC_ARN           | No       | (empty)                 | ARN of SNS topic for SES bounce notifications    |
 * | SUPPRESSION_AUTO_EXPIRE_DAYS| No       | 365                     | Days before auto-suppression expires             |
 * | BOUNCE_RATIO_ALARM_THRESHOLD| No       | 0.05                    | Bounce ratio threshold for alarms (e.g. 0.05=5%)|
 * | OUTBOX_DISPATCHER_ENABLED   | No       | false                   | Start the transactional outbox dispatcher worker; accepts true/false/1/0/yes/no/on/off |
 * | OFAC_LIST_URL               | No       | (empty)                 | URL for OFAC SDN list CSV                         |
 * | OFAC_SIG_URL                | No       | (empty)                 | URL for OFAC SDN list Ed25519 signature (hex)     |
 * | OFAC_TRUST_ANCHOR_BASE64    | No       | (empty)                 | Base64-encoded Ed25519 public key for OFAC sig vfy |
 * | OFAC_FETCH_TIMEOUT_MS       | No       | 30000                   | Timeout in ms for OFAC list fetch                 |
 * | SCIM_TOKEN                  | No       | (empty)                 | Bearer token for SCIM 2.0 provisioning API       |
 * | KYC_CIRCUIT_TRIP_ERRORS     | No       | 3                       | Consecutive failures before KYC circuit breaker trips |
 * | KYC_CIRCUIT_CACHE_TTL_MS    | No       | 300000                  | KYC cache TTL in ms for cached decisions          |
 * | KYC_CIRCUIT_HALF_OPEN_MS    | No       | 30000                   | Wait time in ms before half-open probe            |
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ROLE: z.enum(["api", "batch", "all"]).optional(),
  PORT: z.coerce.number().int().positive().default(4000),
  API_VERSION_PREFIX: z.string().default("/api/v1"),
  DATABASE_URL: z.string().optional(),
  WEBHOOK_QUEUE_MAX_DEPTH: z.coerce.number().int().positive().default(100),
  JWT_SECRET: z.string().min(16).optional(),
  JWT_SECRET_PREVIOUS: z.string().optional(),
  JWT_KEY_ID: z.string().optional(),
  JWT_PREVIOUS_KEY_ID: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().optional(),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  STELLAR_HORIZON_URLS: z.string().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
  STELLAR_SERVER_SECRET: z.string().min(1).optional(),
  STELLAR_TIMEOUT: z.coerce.number().int().positive().max(300000).default(30000),
  STELLAR_MAX_FEE: z.coerce.number().int().positive().max(10000000).default(100000),
  ALLOWED_ORIGINS: z.string().optional(),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  AUDIT_EXPORT_SIGNING_KEY: z.string().min(1).optional(),
  AUDIT_EXPORT_PUBLIC_KEY: z.string().min(1).optional(),
  SESSION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  EMAIL_PROVIDER: z.enum(["sendgrid", "smtp", "mock"]).optional(),
  FROM_EMAIL: z.string().email().optional(),
  CURSOR_SIGNING_SECRET: z.string().min(16).optional(),
  REGION: z.string().default("us-east-1"),
  FAILOVER_ACTIVE_REGION: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  HOLIDAY_CALENDAR_FILE_PATH: z.string().optional(),
  HOLIDAY_CALENDAR_SECRET: z.string().optional(),
  HOLIDAY_FALLBACK_SHIFT_POLICY: z.enum(['previous', 'next']).default('previous'),
  // Boolean flags use envBoolean() rather than z.coerce.boolean():
  // Boolean("false") === true, so coerce silently turned "disabled" values
  // into enabled features (issue #1305).
  EMAIL_DELIVERABILITY_ENABLED: envBoolean(true),
  SENDGRID_EVENT_WEBHOOK_SECRET: z.string().optional(),
  SES_SNS_TOPIC_ARN: z.string().optional(),
  KYC_CIRCUIT_TRIP_ERRORS: z.coerce.number().int().positive().default(3),
  KYC_CIRCUIT_CACHE_TTL_MS: z.coerce.number().int().positive().default(300000),
  KYC_CIRCUIT_HALF_OPEN_MS: z.coerce.number().int().positive().default(30000),
  SUPPRESSION_AUTO_EXPIRE_DAYS: z.coerce.number().int().positive().default(365),
  BOUNCE_RATIO_ALARM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.05),
  OUTBOX_DISPATCHER_ENABLED: envBoolean(false),
}).refine(data => {
  if (data.NODE_ENV === "production" && !data.DATABASE_URL) return false;
  return true;
}, { message: "DATABASE_URL is required in production", path: ["DATABASE_URL"] })
.refine(data => {
  if (data.NODE_ENV === "production" && !data.JWT_SECRET) return false;
  return true;
}, { message: "JWT_SECRET is required in production", path: ["JWT_SECRET"] })
.refine(data => {
  if (data.NODE_ENV !== "test" && !data.STELLAR_SERVER_SECRET) return false;
  return true;
}, { message: "STELLAR_SERVER_SECRET is required", path: ["STELLAR_SERVER_SECRET"] })
.refine(data => {
  if (data.EMAIL_PROVIDER === "sendgrid" && !data.SENDGRID_API_KEY) return false;
  return true;
}, { message: "SENDGRID_API_KEY is required when EMAIL_PROVIDER=sendgrid", path: ["SENDGRID_API_KEY"] })
.refine(data => {
  if (data.EMAIL_PROVIDER === "smtp" && !data.SMTP_HOST) return false;
  return true;
}, { message: "SMTP_HOST is required when EMAIL_PROVIDER=smtp", path: ["SMTP_HOST"] })
.refine(data => {
  if (Boolean(data.SMTP_USER) !== Boolean(data.SMTP_PASS)) return false;
  return true;
}, { message: "SMTP_USER and SMTP_PASS must be provided together", path: ["SMTP_USER"] })
.refine(data => {
  if (data.NODE_ENV === "production" && data.EMAIL_PROVIDER === "mock") return false;
  return true;
}, { message: "EMAIL_PROVIDER=mock is not permitted in production", path: ["EMAIL_PROVIDER"] })
.refine(data => {
  if (data.NODE_ENV === "production" && !data.AUDIT_EXPORT_SIGNING_KEY) return false;
  return true;
}, { message: "AUDIT_EXPORT_SIGNING_KEY is required in production to sign audit log exports", path: ["AUDIT_EXPORT_SIGNING_KEY"] });

export type Config = z.infer<typeof envSchema> & { 
  ALLOWED_ORIGINS_ARRAY: string[];
  STELLAR_HORIZON_URLS_ARRAY: string[];
};

export function buildConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    // Issue messages for this schema never embed the raw environment value:
    // zod's built-in messages describe the expected shape (e.g. "Too small:
    // expected string to have >=16 characters") and custom messages are
    // authored locally without interpolating input. Path + message are
    // therefore safe to log without leaking secrets such as DATABASE_URL.
    const errorMessages = result.error.issues.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
    console.error(`[FATAL] Configuration validation failed: Missing or invalid required environment variables: ${errorMessages}`);
    process.exit(1);
  }

  const cfg = result.data;

  let allowedOriginsArray: string[] = [];
  if (!cfg.ALLOWED_ORIGINS) {
    if (cfg.NODE_ENV === 'production') {
      allowedOriginsArray = [];
    } else {
      allowedOriginsArray = ["http://localhost:3000"];
    }
  } else {
    allowedOriginsArray = cfg.ALLOWED_ORIGINS
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  let horizonUrlsArray: string[] = [];
  if (cfg.STELLAR_HORIZON_URLS) {
    horizonUrlsArray = cfg.STELLAR_HORIZON_URLS
      .split(",")
      .map(url => url.trim())
      .filter(url => url.length > 0);
  } else if (cfg.STELLAR_HORIZON_URL) {
    horizonUrlsArray = [cfg.STELLAR_HORIZON_URL];
  } else {
    horizonUrlsArray = [
      cfg.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org',
    ];
  }

  return {
    ...cfg,
    ALLOWED_ORIGINS_ARRAY: allowedOriginsArray,
    STELLAR_HORIZON_URLS_ARRAY: horizonUrlsArray
  };
}

export const env = buildConfig();

