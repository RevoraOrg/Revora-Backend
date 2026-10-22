/**
 * @file scripts/capture-explain.ts
 * @description
 * Captures EXPLAIN (FORMAT JSON) baselines for key session-store queries and
 * persists them to src/db/fixtures/explain_baselines.json.
 *
 * Also exports `checkRegressionAlarm` for use in CI checks or tests: given an
 * observed plan cost and a baseline, it throws if the cost exceeds
 * `baseline * regressionFactor` (default 2×).
 *
 * Usage:
 *   npx ts-node scripts/capture-explain.ts
 *
 * Environment variables:
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// ─── Queries to baseline ─────────────────────────────────────────────────────

/**
 * Queries whose EXPLAIN plans we track.
 * Every query in this map MUST use the partial index
 * `idx_sessions_active_user_id` (WHERE revoked_at IS NULL) when the index is
 * present — any plan change is surfaced by the regression alarm.
 */
const QUERIES: Record<string, string> = {
  activeSessionLookupByUserId:
    'SELECT id, token_hash FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
  sessionLookupByTokenHash:
    'SELECT * FROM sessions WHERE token_hash = $1 LIMIT 1',
  countActiveSessions:
    'SELECT COUNT(*)::int AS count FROM sessions WHERE expires_at > NOW() AND revoked_at IS NULL',
};

/** Placeholder params for parameterised queries so EXPLAIN can run. */
const QUERY_PARAMS: Record<string, unknown[]> = {
  activeSessionLookupByUserId: ['00000000-0000-0000-0000-000000000000'],
  sessionLookupByTokenHash: [
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  ],
  countActiveSessions: [],
};

// ─── Regression alarm ────────────────────────────────────────────────────────

export interface BaselineEntry {
  total_cost: number;
  plan_type: string;
  index_name?: string;
  plan_json?: unknown;
}

/**
 * Throws a descriptive error when `observedCost` exceeds
 * `baseline.total_cost * regressionFactor`.
 *
 * @param queryName       - Human-readable query identifier (for error messages).
 * @param observedCost    - Plan cost from the live EXPLAIN output.
 * @param baseline        - Committed baseline entry loaded from the fixture file.
 * @param regressionFactor - Multiplier for the alarm threshold (default 2).
 */
export function checkRegressionAlarm(
  queryName: string,
  observedCost: number,
  baseline: BaselineEntry,
  regressionFactor = 2,
): void {
  const alarmThreshold = baseline.total_cost * regressionFactor;
  if (observedCost > alarmThreshold) {
    throw new Error(
      `Regression Alarm: Plan cost for "${queryName}" (${observedCost.toFixed(2)}) ` +
      `exceeds baseline * ${regressionFactor} (${alarmThreshold.toFixed(2)}). ` +
      `Baseline plan_type="${baseline.plan_type}", ` +
      `index="${baseline.index_name ?? 'none'}". ` +
      `Ensure the partial index idx_sessions_active_user_id is present.`,
    );
  }
}

// ─── Baseline capture ────────────────────────────────────────────────────────

async function captureBaselines(): Promise<void> {
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'revora_test',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
  });

  try {
    const baselines: Record<string, BaselineEntry> = {};

    for (const [name, sql] of Object.entries(QUERIES)) {
      const params = QUERY_PARAMS[name] ?? [];

      const explainQuery = `EXPLAIN (FORMAT JSON) ${sql}`;
      const res = await pool.query(explainQuery, params);

      const plan = res.rows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>;

      const entry: BaselineEntry = {
        total_cost: plan['Total Cost'] as number,
        plan_type: plan['Node Type'] as string,
        index_name: plan['Index Name'] as string | undefined,
        plan_json: plan,
      };

      baselines[name] = entry;

      console.log(
        `  ${name}: cost=${entry.total_cost} plan_type=${entry.plan_type}` +
        (entry.index_name ? ` index=${entry.index_name}` : ''),
      );
    }

    const fixturesPath = path.join(__dirname, '..', 'src', 'db', 'fixtures');
    if (!fs.existsSync(fixturesPath)) {
      fs.mkdirSync(fixturesPath, { recursive: true });
    }

    // Strip plan_json from the committed fixture — it's noisy and we only need
    // total_cost + plan_type for the regression alarm.
    const fixtureBaselines = Object.fromEntries(
      Object.entries(baselines).map(([k, v]) => [
        k,
        { total_cost: v.total_cost, plan_type: v.plan_type, index_name: v.index_name },
      ]),
    );

    const baselineFile = path.join(fixturesPath, 'explain_baselines.json');
    fs.writeFileSync(baselineFile, JSON.stringify(fixtureBaselines, null, 2));

    console.log(`\nSuccessfully captured EXPLAIN baselines to ${baselineFile}`);
  } catch (error) {
    console.error('Error capturing EXPLAIN baselines:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  captureBaselines();
}
