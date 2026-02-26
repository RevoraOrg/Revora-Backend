import { Pool, PoolClient } from 'pg';

const pool = new Pool({
     connectionString: process.env.DATABASE_URL,
     ssl: { rejectUnauthorized: false },
     max: 10,
     idleTimeoutMillis: 30_000,
     connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => console.error('[db] idle client error:', err));

export const getClient = (): Promise<PoolClient> => pool.connect();

export const query = <T extends object = Record<string, unknown>>(
     sql: string,
     params?: unknown[],
) => pool.query<T>(sql, params);

export const closePool = () => pool.end();

export const dbHealth = async () => {
     const start = Date.now();
     try {
          await pool.query('SELECT 1');
          return { healthy: true, latencyMs: Date.now() - start };
     } catch (err) {
          return {
               healthy: false,
               latencyMs: Date.now() - start,
               error: err instanceof Error ? err.message : String(err),
          };
     }
};