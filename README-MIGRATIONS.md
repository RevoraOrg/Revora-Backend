# Database Migrations

## Prefix Numbering Rule

All database migrations must follow a strict prefix numbering convention to ensure deterministic execution order and prevent collisions.

### Rules

1. **Numeric Prefix**: Every migration file MUST begin with a numeric prefix followed by an underscore (e.g., `001_create_users.sql`).
2. **Sequential Ordering**: The prefixes MUST be strictly monotonic and strictly increasing.
3. **No Duplicates**: Duplicate prefixes are NOT allowed. If two developers create a migration at the same time with the same prefix, one must be renamed during the merge process.
4. **No Out-of-Band Migrations**: The `999_*` prefix is flagged as an out-of-band prefix and is rejected by the system.
5. **Extension**: All migration files MUST have the `.sql` extension.
6. **Hidden Files**: Hidden files (starting with `.`) are ignored.

These rules are enforced by the `resolveMigrations` function in `src/db/migrate.js` during the test run and at startup. A duplicate numeric prefix or non-monotonic ordering will fail the test run with a clear diagnostic.
