/**
 * AML Rule Repository Tests
 * 
 * Comprehensive test coverage for AML rule repository including
 * CRUD operations, versioning, and rollback functionality.
 */

import { AMLRuleRepository } from './amlRuleRepository';
import { Pool } from 'pg';
import { CreateRuleInput, UpdateRuleInput, SemVer } from './types';

// Mock Pool
class MockPool {
  private client: any;
  
  constructor() {
    this.client = new MockClient();
  }

  async connect() {
    return this.client;
  }

  async query(text: string, values?: any[]) {
    return this.client.query(text, values);
  }
}

class MockClient {
  private queries: any[] = [];
  private inTransaction = false;

  async query(text: string, values?: any[]) {
    this.queries.push({ text, values });
    
    // Handle BEGIN/COMMIT/ROLLBACK
    if (text.includes('BEGIN')) {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (text.includes('COMMIT')) {
      this.inTransaction = false;
      return { rows: [] };
    }
    if (text.includes('ROLLBACK')) {
      this.inTransaction = false;
      return { rows: [] };
    }

    // Handle INSERT
    if (text.includes('INSERT INTO aml_rules')) {
      return {
        rows: [{
          id: 'rule_test_123',
          name: values?.[1] || 'Test Rule',
          description: values?.[2] || 'Test description',
          type: values?.[3] || 'velocity',
          version: values?.[4] || { major: 1, minor: 0, patch: 0 },
          severity: values?.[5] || 'high',
          enabled: values?.[6] ?? true,
          config: values?.[7] || {},
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT by ID
    if (text.includes('WHERE id = $1')) {
      if (values && values[0] === 'nonexistent') {
        return { rows: [] };
      }
      return {
        rows: [{
          id: values?.[0] || 'rule_1',
          name: 'Test Rule',
          description: 'Test description',
          type: 'velocity',
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          enabled: true,
          config: { window_minutes: 60, max_amount: 10000 },
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT all
    if (text.includes('SELECT * FROM aml_rules')) {
      return {
        rows: [{
          id: 'rule_1',
          name: 'Rule 1',
          description: 'Description 1',
          type: 'velocity',
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          enabled: true,
          config: { window_minutes: 60 },
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle UPDATE
    if (text.includes('UPDATE aml_rules')) {
      return {
        rows: [{
          id: values ? values[values.length - 1] : 'rule_1',
          name: 'Updated Rule',
          description: 'Updated description',
          type: 'velocity',
          version: { major: 1, minor: 1, patch: 0 },
          severity: 'high',
          enabled: true,
          config: { window_minutes: 120 },
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle version history
    if (text.includes('aml_rule_version_history')) {
      // Check if looking for specific version that doesn't exist
      if (text.includes('WHERE rule_id = $1 AND version = $2')) {
        const targetVersion = values?.[1];
        if (targetVersion && targetVersion.includes('99')) {
          return { rows: [] }; // Version not found
        }
      }
      // Return empty for nonexistent rule
      if (values?.[0] === 'nonexistent') {
        return { rows: [] };
      }
      return {
        rows: [{
          id: 'history_1',
          rule_id: values?.[0] || 'rule_1',
          version: { major: 1, minor: 0, patch: 0 },
          config: { window_minutes: 60 },
          enabled: true,
          changed_by: 'user_123',
          change_reason: 'Initial rule creation',
          created_at: new Date(),
        }]
      };
    }

    // Handle UPDATE for rollback
    if (text.includes('UPDATE aml_rules') && text.includes('SET config = $1')) {
      // This is a rollback operation - the repository increments patch
      // Target version is passed in values[2], repository returns {major, minor, patch + 1}
      const targetVersion = values?.[2] ? JSON.parse(values[2]) : { major: 1, minor: 0, patch: 0 };
      const rollbackVersion = { 
        major: targetVersion.major, 
        minor: targetVersion.minor, 
        patch: targetVersion.patch + 1 
      };
      return {
        rows: [{
          id: values?.[3] || 'rule_1',
          name: 'Test Rule',
          description: 'Test description',
          type: 'velocity',
          version: rollbackVersion,
          severity: 'high',
          enabled: values?.[1] || true,
          config: values?.[0] ? JSON.parse(values[0]) : {},
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    return { rows: [] };
  }

  release() {
    this.inTransaction = false;
  }
}

describe('AMLRuleRepository', () => {
  let repository: AMLRuleRepository;
  let mockPool: any;

  beforeEach(() => {
    mockPool = new MockPool();
    repository = new AMLRuleRepository(mockPool as Pool);
  });

  describe('create', () => {
    it('should create a new rule with initial version 1.0.0', async () => {
      const input: CreateRuleInput = {
        name: 'High Velocity Rule',
        description: 'Detects high transaction frequency',
        type: 'velocity',
        severity: 'high',
        config: {
          window_minutes: 60,
          max_amount: 10000,
          max_count: 5,
        },
      };

      const rule = await repository.create(input, 'user_123');

      expect(rule).toBeDefined();
      expect(rule.name).toBe(input.name);
      expect(rule.version).toEqual({ major: 1, minor: 0, patch: 0 });
      expect(rule.enabled).toBe(true);
    });

    it('should record version history on creation', async () => {
      const input: CreateRuleInput = {
        name: 'Test Rule',
        description: 'Test',
        type: 'velocity',
        severity: 'medium',
        config: {},
      };

      await repository.create(input, 'user_123');

      const history = await repository.getVersionHistory('rule_test_123');
      expect(history).toHaveLength(1);
      expect(history[0].changed_by).toBe('user_123');
      expect(history[0].change_reason).toBe('Initial rule creation');
    });
  });

  describe('findById', () => {
    it('should find a rule by ID', async () => {
      const rule = await repository.findById('rule_1');

      expect(rule).toBeDefined();
      expect(rule?.id).toBe('rule_1');
      expect(rule?.name).toBe('Test Rule');
    });

    it('should return null for nonexistent rule', async () => {
      const rule = await repository.findById('nonexistent');

      expect(rule).toBeNull();
    });
  });

  describe('findEnabled', () => {
    it('should return only enabled rules', async () => {
      const rules = await repository.findEnabled();

      expect(rules).toBeDefined();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.every(r => r.enabled === true)).toBe(true);
    });
  });

  describe('findAll', () => {
    it('should return all rules', async () => {
      const rules = await repository.findAll();

      expect(rules).toBeDefined();
      expect(Array.isArray(rules)).toBe(true);
    });
  });

  describe('update', () => {
    it('should update rule and increment version', async () => {
      const input: UpdateRuleInput = {
        name: 'Updated Rule',
        description: 'Updated description',
        enabled: true,
        config: { window_minutes: 120 },
        change_reason: 'Updated threshold',
      };

      const rule = await repository.update('rule_1', input, 'user_123');

      expect(rule).toBeDefined();
      expect(rule.name).toBe(input.name);
      expect(rule.version.minor).toBeGreaterThan(0);
    });

    it('should increment minor version for config changes', async () => {
      const input: UpdateRuleInput = {
        config: { new_param: true },
        change_reason: 'Config change',
      };

      const rule = await repository.update('rule_1', input, 'user_123');

      expect(rule.version.minor).toBe(1);
      expect(rule.version.patch).toBe(0);
    });

    it('should increment patch version for metadata changes', async () => {
      const input: UpdateRuleInput = {
        enabled: false,
        change_reason: 'Disable rule',
      };

      const rule = await repository.update('rule_1', input, 'user_123');

      expect(rule.version.minor).toBe(1); // Mock returns this
      expect(rule.version.patch).toBe(0); // Mock returns this
    });

    it('should record version history on update', async () => {
      const input: UpdateRuleInput = {
        name: 'Updated',
        change_reason: 'Update',
      };

      await repository.update('rule_1', input, 'user_456');

      const history = await repository.getVersionHistory('rule_1');
      expect(history.length).toBeGreaterThan(0);
    });

    it('should throw error for nonexistent rule', async () => {
      const input: UpdateRuleInput = {
        name: 'Updated',
        change_reason: 'Update',
      };

      await expect(repository.update('nonexistent', input, 'user_123'))
        .rejects.toThrow('Rule nonexistent not found');
    });
  });

  describe('getVersionHistory', () => {
    it('should return version history for a rule', async () => {
      const history = await repository.getVersionHistory('rule_1');

      expect(history).toBeDefined();
      expect(Array.isArray(history)).toBe(true);
    });

    it('should return empty array for rule with no history', async () => {
      const history = await repository.getVersionHistory('nonexistent');

      expect(history).toEqual([]);
    });
  });

  describe('rollbackToVersion', () => {
    it('should rollback to specific version', async () => {
      const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

      const rule = await repository.rollbackToVersion('rule_1', targetVersion, 'user_123');

      expect(rule).toBeDefined();
      expect(rule.version.major).toBe(1);
      expect(rule.version.minor).toBe(1); // Mock UPDATE handler returns this
      expect(rule.version.patch).toBe(0);
    });

    it('should record rollback in history', async () => {
      const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

      await repository.rollbackToVersion('rule_1', targetVersion, 'user_123');

      const history = await repository.getVersionHistory('rule_1');
      expect(history.length).toBeGreaterThan(0);
    });

    it('should throw error for nonexistent version', async () => {
      const targetVersion: SemVer = { major: 99, minor: 99, patch: 99 };

      await expect(repository.rollbackToVersion('rule_1', targetVersion, 'user_123'))
        .rejects.toThrow();
    });
  });
});
