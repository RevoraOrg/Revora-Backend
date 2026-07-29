import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Define the baseline queries we want to track
const QUERIES = {
  activeSessionLookupByUserId: 'SELECT id, token_hash FROM sessions WHERE user_id = $1 AND revoked_at IS NULL',
  sessionLookupByTokenHash: 'SELECT * FROM sessions WHERE token_hash = $1 LIMIT 1',
  countActiveSessions: 'SELECT COUNT(*)::int AS count FROM sessions WHERE expires_at > NOW() AND revoked_at IS NULL'
};

async function captureBaselines() {
  const pool = new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME ?? 'revora_test',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
  });

  try {
    const baselines: Record<string, any> = {};

    for (const [name, sql] of Object.entries(QUERIES)) {
      let querySql = sql;
      let params: any[] = [];

      if (name === 'activeSessionLookupByUserId') {
        params = ['00000000-0000-0000-0000-000000000000'];
      } else if (name === 'sessionLookupByTokenHash') {
        params = ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'];
      }

      // Run EXPLAIN (FORMAT JSON)
      const explainQuery = `EXPLAIN (FORMAT JSON) ${querySql}`;
      const res = await pool.query(explainQuery, params);
      
      const plan = res.rows[0]['QUERY PLAN'][0].Plan;
      
      baselines[name] = {
        total_cost: plan['Total Cost'],
        plan_type: plan['Node Type'],
        index_name: plan['Index Name'],
        plan_json: plan
      };
    }

    const fixturesPath = path.join(__dirname, '..', 'src', 'db', 'fixtures');
    if (!fs.existsSync(fixturesPath)) {
      fs.mkdirSync(fixturesPath, { recursive: true });
    }

    const baselineFile = path.join(fixturesPath, 'explain_baselines.json');
    fs.writeFileSync(baselineFile, JSON.stringify(baselines, null, 2));
    
    console.log(`Successfully captured EXPLAIN baselines to ${baselineFile}`);
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
