require('dotenv/config');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * Resolves, filters, sorts, and validates migration filenames.
 *
 * Enforces the following rules:
 * - Hidden files (starting with '.') are ignored.
 * - Missing '.sql' extension is rejected (unless strictExtensions is false).
 * - Files must start with a numeric prefix (e.g. '001_').
 * - Duplicate prefixes are rejected (unless allowDuplicates is true).
 * - Prefix '999' is flagged/rejected as out-of-band (unless allowOutOfBand is true).
 * - The sequence of numeric prefixes must be monotonic (strictly increasing, or non-decreasing if duplicates are allowed).
 *
 * @param {string[]} filenames
 * @param {object} [options]
 * @param {boolean} [options.allowDuplicates=false]
 * @param {boolean} [options.allowOutOfBand=false]
 * @param {boolean} [options.strictExtensions=true]
 * @returns {string[]} Resolved and sorted list of valid migration filenames
 */
function resolveMigrations(filenames, options = {}) {
    const {
        allowDuplicates = false,
        allowOutOfBand = false,
        strictExtensions = true,
    } = options;

    const resolved = [];
    const seenPrefixes = new Set();

    for (const filename of filenames) {
        // 1. Hidden files are ignored
        if (filename.startsWith('.')) {
            continue;
        }

        // 2. Missing .sql extension rejected
        if (!filename.endsWith('.sql')) {
            if (strictExtensions) {
                throw new Error(`Migration file lacks .sql extension: ${filename}`);
            }
            continue;
        }

        // 3. Must start with numeric prefix
        const match = filename.match(/^(\d+)_(.*)\.sql$/);
        if (!match) {
            throw new Error(`Migration file name does not start with a numeric prefix: ${filename}`);
        }

        const prefixStr = match[1];
        const prefixNum = parseInt(prefixStr, 10);

        // 4. Duplicate prefix rejected
        if (seenPrefixes.has(prefixStr) && !allowDuplicates) {
            throw new Error(`Duplicate migration prefix detected: ${prefixStr} (found in ${filename})`);
        }
        seenPrefixes.add(prefixStr);

        // 5. 999_* flagged as out-of-band
        if (prefixStr === '999' && !allowOutOfBand) {
            throw new Error(`Out-of-band migration prefix 999 detected: ${filename}`);
        }

        resolved.push({
            filename,
            prefixStr,
            prefixNum
        });
    }

    // Sort lexicographically by filename to match database migration resolution order
    resolved.sort((a, b) => a.filename.localeCompare(b.filename));

    // 6. Monotonicity check
    let lastPrefixNum = -1;
    for (const item of resolved) {
        if (allowDuplicates) {
            if (item.prefixNum < lastPrefixNum) {
                throw new Error(`Non-monotonic migration ordering detected: ${item.filename} has prefix ${item.prefixStr} which is less than preceding prefix`);
            }
        } else {
            if (item.prefixNum <= lastPrefixNum) {
                throw new Error(`Non-monotonic migration ordering detected: ${item.filename} has prefix ${item.prefixStr} which is less than or equal to preceding prefix`);
            }
        }
        lastPrefixNum = item.prefixNum;
    }

    return resolved.map(item => item.filename);
}

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

            // Load and resolve migrations with strict options
            const allFiles = fs.readdirSync(migrationsDir);
            const files = resolveMigrations(allFiles);

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

if (require.main === module) {
    runMigrations();
}

module.exports = {
    runMigrations,
    resolveMigrations,
};
