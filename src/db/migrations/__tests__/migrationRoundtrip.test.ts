// Integration test that validates forward‑then‑backward migration round‑trip.
import { Pool } from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { MigrationManager } from '../safety/executor';
import { MigrationRollbackService } from '../safety/rollback';
import { InMemoryMigrationRollbackRepository } from '../safety/rollback';
import { DatabaseBackupService } from '../safety/rollback';
import { MigrationAuditLogger } from '../safety/audit';
import { createMigrationAuditRepository } from '../safety/audit';

describe('Migration round‑trip (forward + rollback)', () => {
  // increase Jest timeout because container startup can be slow
  jest.setTimeout(120_000);

  let container: any;
  let pool: Pool;
  let auditLogger: MigrationAuditLogger;
  let rollbackService: MigrationRollbackService;

  beforeAll(async () => {
    // Spin up a disposable PostgreSQL instance
    container = await new PostgreSqlContainer().start();
    const connectionString = container.getConnectionUri();
    pool = new Pool({ connectionString });

    // Initialise audit logger and rollback infrastructure (in‑memory for tests)
    const auditRepo = createMigrationAuditRepository(pool);
    auditLogger = new MigrationAuditLogger(auditRepo);
    const rollbackRepo = new InMemoryMigrationRollbackRepository();
    const backupService = new DatabaseBackupService(pool, rollbackRepo);
    rollbackService = new MigrationRollbackService(pool, backupService, auditLogger);
  });

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it('should apply all migrations and roll them back successfully', async () => {
    // Run all pending migrations forward
    const manager = new MigrationManager(pool);
    const securityContext = { userId: 'test', userRole: 'admin' } as any; // minimal stub
    const results = await manager.runPendingMigrations(securityContext);

    // Ensure every migration succeeded
    for (const result of results) {
      expect(result.success).toBe(true);
    }

    // Attempt rollback for each executed migration
    for (const exec of results) {
      const execution: any = {
        id: exec.executionId,
        migrationFile: exec.migrationFile,
        executionPlan: exec.executionPlan,
        rollbackAvailable: exec.rollbackAvailable,
      };
      const rollbackResult = await rollbackService.executeRollback(execution, securityContext);
      expect(rollbackResult.success).toBe(true);
    }

    // After all rollbacks, schema_version should be empty
    const client = await pool.connect();
    const { rows } = await client.query('SELECT COUNT(*) FROM schema_version');
    expect(parseInt(rows[0].count, 10)).toBe(0);
    client.release();
  });
});
