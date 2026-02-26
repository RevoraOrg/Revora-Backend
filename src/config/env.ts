import "dotenv/config";

type NodeEnv = "development" | "test" | "production";

type Config = {
  NODE_ENV: NodeEnv;
  PORT: number;
  DATABASE_URL?: string;
  JWT_SECRET?: string;
  STELLAR_NETWORK: "testnet" | "public";
  STELLAR_HORIZON_URL?: string;
  STELLAR_NETWORK_PASSPHRASE?: string;
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
    // Default to localhost in development
    return ["http://localhost:3000"];
  }
  // Split by comma and trim whitespace from each origin
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function buildConfig(): Config {
  const NODE_ENV = normalizeNodeEnv(process.env.NODE_ENV);
  const PORT = parsePort(process.env.PORT);
  const STELLAR_NETWORK = normalizeStellarNetwork(process.env.STELLAR_NETWORK);
  const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);

  const cfg: Config = {
    NODE_ENV,
    PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    STELLAR_NETWORK,
    STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
    STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE,
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
