import { Pool, PoolClient } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => console.error("[db] idle client error:", err));

export const getClient = (): Promise<PoolClient> => pool.connect();

export const query = <T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => pool.query<T>(sql, params);

export const closePool = () => pool.end();

export interface PoolMetrics {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxConnections: number;
}

export interface DbHealthResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  pool?: PoolMetrics;
}

export const dbHealth = async (): Promise<DbHealthResult> => {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return {
      healthy: true,
      latencyMs: Date.now() - start,
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        maxConnections: pool.options.max ?? 10,
      },
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      pool: {
        totalCount: pool.totalCount,
        idleCount: pool.idleCount,
        waitingCount: pool.waitingCount,
        maxConnections: pool.options.max ?? 10,
      },
    };
  }
};
