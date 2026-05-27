import "dotenv/config";
import { z } from "zod";

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
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_VERSION_PREFIX: z.string().default("/api/v1"),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16).optional(),
  JWT_SECRET_PREVIOUS: z.string().optional(),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().optional(),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("testnet"),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  STELLAR_NETWORK_PASSPHRASE: z.string().optional(),
  STELLAR_SERVER_SECRET: z.string().min(1).optional(),
  STELLAR_TIMEOUT: z.coerce.number().int().positive().max(300000).default(30000),
  STELLAR_MAX_FEE: z.coerce.number().int().positive().max(10000000).default(100000),
  ALLOWED_ORIGINS: z.string().optional(),
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
}, { message: "STELLAR_SERVER_SECRET is required", path: ["STELLAR_SERVER_SECRET"] });

export type Config = z.infer<typeof envSchema> & { ALLOWED_ORIGINS_ARRAY: string[] };

export function buildConfig(): Config {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    const errorMessages = result.error.errors.map(e => `${e.path.join('.')}: [REDACTED/INVALID]`).join(', ');
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

  return {
    ...cfg,
    ALLOWED_ORIGINS_ARRAY: allowedOriginsArray
  };
}

export const env = buildConfig();

