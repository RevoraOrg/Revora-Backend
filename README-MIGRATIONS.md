# Managing Database Migrations

This project uses a custom raw SQL migration script to manage database schema changes reliably.

## Structure

- `src/db/migrations/`: Directory where all `.sql` migration files are stored.
- `src/db/migrate.ts`: The script that executes pending migrations against the database. 

## Creating Migrations

To add a new migration, create a new `.sql` file in `src/db/migrations/`. 

**Naming Convention:** 
Use a sequential prefix followed by a descriptive name: `XXX_description.sql` (e.g., `003_add_user_status.sql`). 

All `.sql` files are sorted alphabetically when applied, so the prefix ensures they run in the correct order. The migration script uses a `schema_version` table to track which files have already been applied based on their filename.

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
