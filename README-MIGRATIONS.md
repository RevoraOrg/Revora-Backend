# Managing Database Migrations

This project uses a custom raw SQL migration script to manage database schema changes reliably.

## Structure
 
- `src/db/migrations/`: Directory where all `.sql` migration files are stored.
- `src/db/migrate.ts`: The script that executes pending migrations against the database. 

## Creating Migrations

To add a new migration, create a new `.sql` file in `src/db/migrations/`. 

**Naming Convention & Safety Rules:** 
Use a sequential, zero-padded numeric prefix followed by a descriptive name: `XXX_description.sql` (e.g., `003_add_user_status.sql`). 

To ensure safety and execution predictability, the following strict rules are enforced:
1. **Unique Prefixes**: Every migration file must have a unique sequential prefix. Duplicate prefixes (e.g., two `001_*` files) are strictly rejected to prevent execution order ambiguity and collisions.
2. **Strict Monotonicity**: Alphabetic ordering of the filenames must match their numeric prefix sequence. Non-padded or incorrectly ordered prefixes that violate monotonic progression are caught and rejected.
3. **Out-of-band Prefix (`999_`)**: Filenames starting with `999_*` are flagged as "out-of-band" migrations (used for temporary/development purposes) and will be rejected unless explicit relaxed options are enabled.
4. **Valid File Extension**: Every migration file must end with `.sql`. Files with incorrect extensions (e.g., `.sql.bak` or `.txt`) will be rejected.
5. **Hidden Files**: Any hidden files starting with a dot (e.g., `.DS_Store` or `.gitkeep`) are automatically ignored during migration resolution.

## Running Migrations

Migrations rely on the `DATABASE_URL` environment variable.

1. Ensure your `.env` file has a valid `DATABASE_URL`:
   ```env
   DATABASE_URL="postgres://user:password@localhost:5432/revora"
   ```
2. Run the migration script via npm:
   ```bash
   npm run migrate
   ```

This command will:
1. Compile the TypeScript code (`tsc`).
2. Connect to the database specified by `DATABASE_URL`.
3. Create the `schema_version` table if it doesn't already exist.
4. Apply any `.sql` file in `src/db/migrations/` that hasn't been recorded in `schema_version`, within a transaction.
5. Record the applied filename in `schema_version`.

If a migration fails mid-execution, the transaction will rollback, leaving your database safely unmodified.
