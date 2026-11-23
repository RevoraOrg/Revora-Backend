/**
 * Regression coverage for the `ExecutionPlanGenerator` rollback contract,
 * specifically the `return undefined; // Manual rollback required` branch in
 * `generateRollbackSql` (src/db/migrations/safety/validation.ts:653).
 *
 * That branch decides whether a step can be rolled back automatically. It feeds
 * `RollbackStrategy.available` / `automated`, which downstream executor and
 * monitoring code trust, so its behaviour is pinned here for both the reversible
 * and the manual-rollback cases.
 */

import { ExecutionPlanGenerator, SQL_PATTERNS } from './validation';
import type { MigrationFile } from './types';

const mkMigration = (
  content: string,
  overrides: Partial<MigrationFile> = {},
): MigrationFile => ({
  filename: 'migration.sql',
  filepath: '/tmp/migration.sql',
  content,
  checksum: 'checksum',
  size: Buffer.byteLength(content, 'utf8'),
  riskLevel: 'low',
  requiresDowntime: false,
  requiresBackup: false,
  dependencies: [],
  ...overrides,
});

describe('ExecutionPlanGenerator rollback coverage', () => {
  let generator: ExecutionPlanGenerator;

  beforeEach(() => {
    generator = new ExecutionPlanGenerator();
    // SQL_PATTERNS use the global flag, so `RegExp.test` is stateful across
    // calls. Reset it so risk-derived output is deterministic per test.
    for (const pattern of SQL_PATTERNS) {
      pattern.pattern.lastIndex = 0;
    }
  });

  it('marks a step as manual-rollback when generateRollbackSql returns undefined', () => {
    const plan = generator.generatePlan(
      mkMigration('ALTER TABLE users ADD COLUMN email TEXT;'),
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].type).toBe('alter');
    expect(plan.steps[0].rollbackSql).toBeUndefined();

    // The undefined branch must surface as an non-automatable rollback strategy.
    expect(plan.rollbackStrategy.available).toBe(false);
    expect(plan.rollbackStrategy.steps).toHaveLength(0);
    expect(plan.rollbackStrategy.automated).toBe(false);
    expect(plan.rollbackStrategy.dataLossRisk).toBe('moderate');
    expect(plan.rollbackStrategy.estimatedRollbackTime).toBe(0);
  });

  it('returns undefined rollback for plain data statements too', () => {
    const plan = generator.generatePlan(mkMigration('INSERT INTO users (id) VALUES (1);'));

    expect(plan.steps[0].type).toBe('data');
    expect(plan.steps[0].rollbackSql).toBeUndefined();
    expect(plan.rollbackStrategy.available).toBe(false);
  });

  it('keeps reversible steps and flags a partially automated plan', () => {
    const plan = generator.generatePlan(
      mkMigration(
        'CREATE TABLE accounts (id UUID PRIMARY KEY); ALTER TABLE accounts ADD COLUMN balance BIGINT;',
      ),
    );

    expect(plan.steps.map((step) => step.type)).toEqual(['create', 'alter']);
    expect(plan.rollbackStrategy.available).toBe(true);
    expect(plan.rollbackStrategy.steps).toHaveLength(1);
    expect(plan.rollbackStrategy.steps[0].sql).toBe('DROP TABLE IF EXISTS accounts;');
    // 1 rollback step for 2 forward steps => not fully automated.
    expect(plan.rollbackStrategy.automated).toBe(false);
    expect(plan.rollbackStrategy.dataLossRisk).toBe('moderate');
  });

  it('marks a fully reversible plan as automated', () => {
    const plan = generator.generatePlan(
      mkMigration(
        'CREATE TABLE accounts (id UUID PRIMARY KEY); CREATE INDEX idx_accounts_id ON accounts (id);',
      ),
    );

    expect(plan.steps.map((step) => step.type)).toEqual(['create', 'index']);
    const rollbackSql = plan.rollbackStrategy.steps.map((step) => step.sql);
    expect(rollbackSql).toContain('DROP TABLE IF EXISTS accounts;');
    expect(rollbackSql).toContain('DROP INDEX IF EXISTS idx_accounts_id;');
    expect(plan.rollbackStrategy.available).toBe(true);
    expect(plan.rollbackStrategy.automated).toBe(true);
    expect(plan.rollbackStrategy.dataLossRisk).toBe('minimal');
  });

  it('treats DROP TABLE as destructive and requiring downtime', () => {
    const plan = generator.generatePlan(mkMigration('DROP TABLE legacy_accounts;'));

    expect(plan.steps[0].type).toBe('drop');
    expect(plan.steps[0].riskLevel).toBe('critical');
    expect(plan.steps[0].rollbackSql).toBeUndefined();
    expect(plan.requiresDowntime).toBe(true);
    expect(plan.rollbackStrategy.dataLossRisk).toBe('moderate');
    expect(plan.estimatedDuration).toBe(30);
  });

  it('honours an explicit requiresDowntime flag on the migration file', () => {
    const plan = generator.generatePlan(
      mkMigration('CREATE TABLE t (id UUID PRIMARY KEY);', { requiresDowntime: true }),
    );

    expect(plan.requiresDowntime).toBe(true);
    expect(plan.steps[0].type).toBe('create');
  });

  it('estimates duration as the sum of the per-type costs', () => {
    const plan = generator.generatePlan(
      mkMigration(
        'CREATE TABLE t (id UUID PRIMARY KEY); ALTER TABLE t ADD COLUMN c TEXT; CREATE INDEX idx_t_c ON t (c);',
      ),
    );

    // create (60) + alter (120, non-critical) + index (180) = 360
    expect(plan.estimatedDuration).toBe(360);
  });

  it('returns an empty, non-available plan for blank content', () => {
    const plan = generator.generatePlan(mkMigration('   ;  ; '));

    expect(plan.steps).toHaveLength(0);
    expect(plan.rollbackStrategy.available).toBe(false);
    expect(plan.rollbackStrategy.steps).toHaveLength(0);
    expect(plan.estimatedDuration).toBe(0);
  });
});
