require('dotenv/config');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigrations() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error('DATABASE_URL environment variable is not set. Migrations failed.');
        process.exit(1);
    }

    const pool = new Pool({
        connectionString: databaseUrl,
    });

    try {
        const client = await pool.connect();

        try {
            // 1. Ensure schema_version table exists
            await client.query(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

            // 2. Determine applied migrations
            const { rows } = await client.query('SELECT version FROM schema_version');
            const appliedVersions = new Set(rows.map(row => row.version));

            // 3. Read migration files
            // Use __dirname to locate the migrations directory
            const migrationsDir = path.join(__dirname, 'migrations');
            if (!fs.existsSync(migrationsDir)) {
                console.log(`Migrations directory not found at ${migrationsDir}`);
                return;
            }

            const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));
            files.sort();

            let appliedCount = 0;

            for (const filename of files) {
                if (!appliedVersions.has(filename)) {
                    console.log(`Applying migration: ${filename}`);

                    const filepath = path.join(migrationsDir, filename);
                    const sql = fs.readFileSync(filepath, 'utf8');

                    await client.query('BEGIN');
                    try {
                        await client.query(sql);
                        await client.query(
                            'INSERT INTO schema_version (version) VALUES ($1)',
                            [filename]
                        );
                        await client.query('COMMIT');
                        console.log(`Successfully applied ${filename}`);
                        appliedCount++;
                    } catch (e) {
                        await client.query('ROLLBACK');
                        console.error(`Error applying migration ${filename}:`, e);
                        throw e;
                    }
                }
            }

            if (appliedCount === 0) {
                console.log('Database is up to date. No migrations to apply.');
            } else {
                console.log(`Applied ${appliedCount} migration(s) successfully.`);
            }

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigrations();
