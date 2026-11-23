/**
 * Focused behaviour coverage for the DB migration safety type module.
 *
 * `types.ts` exposes the `MigrationEnvironment` / `MigrationStatus` /
 * `MigrationRiskLevel` unions, the environment-specific `DEFAULT_MIGRATION_SAFETY_CONFIGS`
 * table, the security error hierarchy and the documented security assumptions /
 * threat model. Those runtime exports previously had no directly associated test
 * fixture, so their invariants could drift silently.
 */

import {
  DEFAULT_MIGRATION_SAFETY_CONFIGS,
  MIGRATION_SECURITY_ASSUMPTIONS,
  MIGRATION_THREAT_MODEL,
  MigrationAuthorizationError,
  MigrationExecutionError,
  MigrationRiskError,
  MigrationSecurityError,
  MigrationValidationError,
} from './types';
import type {
  MigrationEnvironment,
  MigrationRiskLevel,
  MigrationStatus,
} from './types';

// Compile-time coverage: the union members below must stay assignable, so a
// breaking change to any union fails type-checking as well as the assertions.
const ENVIRONMENTS: MigrationEnvironment[] = ['development', 'staging', 'production'];
const STATUSES: MigrationStatus[] = ['pending', 'running', 'completed', 'failed', 'rolled_back'];
const RISK_LEVELS: MigrationRiskLevel[] = ['low', 'medium', 'high', 'critical'];

describe('MigrationEnvironment and friends', () => {
  it('enumerates the three supported environments exactly', () => {
    expect(ENVIRONMENTS).toEqual(['development', 'staging', 'production']);
    expect(Object.keys(DEFAULT_MIGRATION_SAFETY_CONFIGS).sort()).toEqual(
      [...ENVIRONMENTS].sort(),
    );
  });

  it('exposes the migration lifecycle and risk unions', () => {
    expect(STATUSES).toHaveLength(5);
    expect(STATUSES).toContain('rolled_back');
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

describe('DEFAULT_MIGRATION_SAFETY_CONFIGS', () => {
  it('binds each config to its own environment key', () => {
    for (const env of ENVIRONMENTS) {
      expect(DEFAULT_MIGRATION_SAFETY_CONFIGS[env].environment).toBe(env);
    }
  });

  it('provides sane, positive limits for every environment', () => {
    for (const env of ENVIRONMENTS) {
      const config = DEFAULT_MIGRATION_SAFETY_CONFIGS[env];
      expect(config.allowedRoles.length).toBeGreaterThan(0);
      expect(config.maxConcurrentMigrations).toBeGreaterThanOrEqual(1);
      expect(config.maxMigrationSize).toBeGreaterThan(0);
      expect(config.maxMigrationDuration).toBeGreaterThan(0);
    }
  });

  it('defines a risk threshold entry for every risk level', () => {
    for (const env of ENVIRONMENTS) {
      const { riskThresholds } = DEFAULT_MIGRATION_SAFETY_CONFIGS[env];
      for (const level of RISK_LEVELS) {
        expect(riskThresholds[level]).toBeDefined();
        expect(typeof riskThresholds[level].requireApproval).toBe('boolean');
        expect(typeof riskThresholds[level].requireBackup).toBe('boolean');
        expect(typeof riskThresholds[level].requireDryRun).toBe('boolean');
      }
    }
  });

  it('tightens controls as the environment becomes more sensitive', () => {
    const dev = DEFAULT_MIGRATION_SAFETY_CONFIGS.development;
    const prod = DEFAULT_MIGRATION_SAFETY_CONFIGS.production;

    expect(dev.requireApproval).toBe(false);
    expect(dev.allowDestructiveOperations).toBe(true);

    expect(prod.requireApproval).toBe(true);
    expect(prod.requireBackup).toBe(true);
    expect(prod.requireDryRun).toBe(true);
    expect(prod.allowDestructiveOperations).toBe(false);
    expect(prod.maxConcurrentMigrations).toBe(1);
    expect(prod.maxConcurrentMigrations).toBeLessThan(dev.maxConcurrentMigrations);
    expect(prod.maxMigrationSize).toBeLessThan(dev.maxMigrationSize);
  });

  it('restricts production migrations to maintenance windows', () => {
    const prod = DEFAULT_MIGRATION_SAFETY_CONFIGS.production;
    expect(prod.riskThresholds.low.allowedTimeWindow).toBeDefined();
    expect(prod.riskThresholds.high.allowedTimeWindow).toBeDefined();
    expect(prod.riskThresholds.critical.allowedTimeWindow).toBeDefined();
    expect(prod.riskThresholds.critical.allowedTimeWindow).toEqual({
      start: '00:00',
      end: '06:00',
    });

    expect(
      DEFAULT_MIGRATION_SAFETY_CONFIGS.development.riskThresholds.low.allowedTimeWindow,
    ).toBeUndefined();
  });
});

describe('migration security error hierarchy', () => {
  it('carries a code and optional details on the base error', () => {
    const error = new MigrationSecurityError('boom', 'CUSTOM_CODE', { hint: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MigrationSecurityError');
    expect(error.message).toBe('boom');
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.details).toEqual({ hint: 'x' });
  });

  it('assigns a stable code per subclass', () => {
    expect(new MigrationAuthorizationError('no').code).toBe('MIGRATION_AUTHORIZATION_FAILED');
    expect(new MigrationValidationError('bad').code).toBe('MIGRATION_VALIDATION_FAILED');
    expect(new MigrationRiskError('risky').code).toBe('MIGRATION_RISK_EXCEEDED');
    expect(new MigrationExecutionError('failed').code).toBe('MIGRATION_EXECUTION_FAILED');
  });

  it('keeps every subclass assignable to the base error type', () => {
    const errors: MigrationSecurityError[] = [
      new MigrationAuthorizationError('no'),
      new MigrationValidationError('bad'),
      new MigrationRiskError('risky'),
      new MigrationExecutionError('failed'),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(MigrationSecurityError);
      expect(error.name).toMatch(/^Migration\w+Error$/);
    }
  });
});

describe('documentation tables', () => {
  it('declares all security assumptions as satisfied', () => {
    const groups = Object.values(MIGRATION_SECURITY_ASSUMPTIONS);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const value of Object.values(group)) {
        expect(value).toBe(true);
      }
    }
  });

  it('describes each threat with vectors and mitigations', () => {
    const threats = Object.values(MIGRATION_THREAT_MODEL);
    expect(threats.length).toBeGreaterThanOrEqual(4);
    for (const threat of threats) {
      expect(threat.capabilities.length).toBeGreaterThan(0);
      expect(threat.motivations.length).toBeGreaterThan(0);
      expect(threat.attackVectors.length).toBeGreaterThan(0);
      expect(threat.mitigations.length).toBeGreaterThan(0);
    }
  });
});
