import "dotenv/config";

type NodeEnv = "development" | "test" | "production";

type Config = {
  NODE_ENV: NodeEnv;
  PORT: number;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  JWT_SECRET_PREVIOUS?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWT_CLOCK_TOLERANCE_SECONDS?: number;
  STELLAR_NETWORK: "testnet" | "public";
  STELLAR_HORIZON_URL?: string;
  STELLAR_NETWORK_PASSPHRASE?: string;
  STELLAR_TIMEOUT: number;
  STELLAR_MAX_FEE: number;
  ALLOWED_ORIGINS: string[];
};

function normalizeNodeEnv(value?: string): NodeEnv {
  const v = (value ?? "development").toLowerCase();
  if (v === "production" || v === "test" || v === "development") return v;
  return "development";
}

function parsePort(value?: string): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  return 4000;
}

function normalizeStellarNetwork(value?: string): "testnet" | "public" {
  const v = (value ?? "testnet").toLowerCase();
  if (v === "public" || v === "testnet") return v;
  throw new Error('Invalid STELLAR_NETWORK, expected "public" or "testnet"');
}

function parseAllowedOrigins(value?: string): string[] {
  if (!value) {
    // In production, require explicit configuration
    if (process.env.NODE_ENV === "production") {
      return [];
    }
    // Default to localhost in development
    return ["http://localhost:3000"];
  }

  // Split by comma and trim whitespace from each origin
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // Security: Fail fast if wildcard is found in a list that should be explicit
  if (origins.includes("*") && origins.length > 1) {
    throw new Error("CORS configuration error: ALLOWED_ORIGINS cannot contain both '*' and explicit origins");
  }

  return origins;
}

function parseStellarTimeout(value?: string): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(n) && n > 0 && n <= 300000) return n; // Max 5 minutes
  return 30000; // Default 30 seconds
}

function parseStellarMaxFee(value?: string): number {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(n) && n > 0 && n <= 10000000) return n; // Max 10 XLM in stroops
  return 100000; // Default 0.1 XLM in stroops
}

function buildConfig(): Config {
  const NODE_ENV = normalizeNodeEnv(process.env.NODE_ENV);
  const PORT = parsePort(process.env.PORT);
  const STELLAR_NETWORK = normalizeStellarNetwork(process.env.STELLAR_NETWORK);
  const STELLAR_TIMEOUT = parseStellarTimeout(process.env.STELLAR_TIMEOUT);
  const STELLAR_MAX_FEE = parseStellarMaxFee(process.env.STELLAR_MAX_FEE);
  const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  const jwtClockTolerance = process.env.JWT_CLOCK_TOLERANCE_SECONDS
    ? parseInt(process.env.JWT_CLOCK_TOLERANCE_SECONDS, 10)
    : undefined;

  const cfg: Config = {
    NODE_ENV,
    PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    JWT_SECRET_PREVIOUS: process.env.JWT_SECRET_PREVIOUS,
    JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_AUDIENCE: process.env.JWT_AUDIENCE,
    JWT_CLOCK_TOLERANCE_SECONDS:
      jwtClockTolerance !== undefined && Number.isFinite(jwtClockTolerance) && jwtClockTolerance >= 0
        ? jwtClockTolerance
        : undefined,
    STELLAR_NETWORK,
    STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
    STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE,
    STELLAR_TIMEOUT,
    STELLAR_MAX_FEE,
    ALLOWED_ORIGINS,
  };

  if (cfg.NODE_ENV === "production") {
    if (!cfg.DATABASE_URL)
      throw new Error("DATABASE_URL is required in production");
    if (!cfg.JWT_SECRET)
      throw new Error("JWT_SECRET is required in production");
  }

  return cfg;
}

export const env = buildConfig();
export type { Config };
