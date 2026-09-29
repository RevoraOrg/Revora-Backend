/**
 * AML Rule Repository Tests
 * 
 * Comprehensive test coverage for AML rule repository including
 * CRUD operations, versioning, rollback functionality, failure paths,
 * and boundary conditions.
 */

import { AMLRuleRepository } from './amlRuleRepository';
import { Pool, QueryResult } from 'pg';
import { CreateRuleInput, UpdateRuleInput, SemVer } from './types';

interface QueryCall {
  text: string;
  values?: unknown[];
}

interface MockQueryResult<T = unknown> {
  rows: T[];
  command?: string;
  rowCount?: number;
  oid?: number;
  fields?: unknown[];
}

// Mock Pool
class MockPool {
  public client: MockClient;
  
  constructor() {
    this.client = new MockClient();
  }

  async connect(): Promise<MockClient> {
    return this.client;
  }

  async query(text: string, values?: unknown[]): Promise<QueryResult<unknown>> {
    return this.client.query(text, values) as Promise<QueryResult<unknown>>;
  }
}

class MockClient {
  public queries: QueryCall[] = [];
  public inTransaction = false;
  public isReleased = false;
  public simulatedError: Error | null = null;
  public errorOnQueryText: string | null = null;
  public nonexistentRuleIds: Set<string> = new Set([
    'nonexistent',
    '',
    '   ',
    'rule_not_found',
    'rule/404#special!',
    'rule@special#1',
    '00000000-0000-0000-0000-000000000000',
  ]);
  public nonexistentVersions: Set<string> = new Set();

  async query(text: string, values?: unknown[]): Promise<MockQueryResult<unknown>> {
    this.queries.push({ text, values });

    if (this.simulatedError) {
      throw this.simulatedError;
    }

    if (this.errorOnQueryText && text.includes(this.errorOnQueryText)) {
      throw new Error(`Simulated database failure on: ${this.errorOnQueryText}`);
    }
    
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
          name: (values?.[1] as string) || 'Test Rule',
          description: (values?.[2] as string) || 'Test description',
          type: (values?.[3] as string) || 'velocity',
          version: values?.[4] || { major: 1, minor: 0, patch: 0 },
          severity: (values?.[5] as string) || 'high',
          enabled: (values?.[6] as boolean) ?? true,
          config: values?.[7] || {},
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle SELECT by ID
    if (text.includes('WHERE id = $1')) {
      const ruleId = values ? String(values[0]) : '';
      if (this.nonexistentRuleIds.has(ruleId)) {
        return { rows: [] };
      }
      return {
        rows: [{
          id: ruleId || 'rule_1',
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
    if (text.includes('SELECT * FROM aml_rules') && !text.includes('WHERE')) {
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

    // Handle version history
    if (text.includes('aml_rule_version_history')) {
      // Check if looking for specific version
      if (text.includes('WHERE rule_id = $1 AND version = $2')) {
        const ruleId = values ? String(values[0]) : '';
        const targetVersionStr = values ? String(values[1]) : '';
        if (
          this.nonexistentRuleIds.has(ruleId) ||
          targetVersionStr.includes('99') ||
          targetVersionStr.includes('"major":0,"minor":0,"patch":0') ||
          targetVersionStr.includes('-1') ||
          this.nonexistentVersions.has(targetVersionStr)
        ) {
          return { rows: [] }; // Version not found
        }

        let parsedVersion: SemVer = { major: 1, minor: 0, patch: 0 };
        try {
          parsedVersion = JSON.parse(targetVersionStr);
        } catch {
          // fallback
        }

        return {
          rows: [{
            id: 'history_1',
            rule_id: ruleId || 'rule_1',
            version: parsedVersion,
            config: { window_minutes: 60, max_amount: 10000 },
            enabled: true,
            changed_by: 'user_123',
            change_reason: 'Initial rule creation',
            created_at: new Date(),
          }]
        };
      }

      // Return empty for nonexistent rule in version history list
      if (values && this.nonexistentRuleIds.has(String(values[0]))) {
        return { rows: [] };
      }
      return {
        rows: [{
          id: 'history_1',
          rule_id: values ? String(values[0]) : 'rule_1',
          version: { major: 1, minor: 0, patch: 0 },
          config: { window_minutes: 60 },
          enabled: true,
          changed_by: 'user_123',
          change_reason: 'Initial rule creation',
          created_at: new Date(),
        }]
      };
    }

    // Handle UPDATE for rollback (must precede generic UPDATE)
    if (text.includes('UPDATE aml_rules') && text.replace(/\s+/g, ' ').includes('SET config = $1, enabled = $2, version = $3')) {
      const rollbackVersion = values?.[2]
        ? (typeof values[2] === 'string' ? JSON.parse(values[2]) : values[2])
        : { major: 1, minor: 0, patch: 1 };
      const config = values?.[0]
        ? (typeof values[0] === 'string' ? JSON.parse(values[0]) : values[0])
        : {};
      return {
        rows: [{
          id: values?.[3] ? String(values[3]) : 'rule_1',
          name: 'Test Rule',
          description: 'Test description',
          type: 'velocity',
          version: rollbackVersion,
          severity: 'high',
          enabled: values?.[1] ?? true,
          config,
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    // Handle normal UPDATE
    if (text.includes('UPDATE aml_rules')) {
      const ruleId = values ? String(values[values.length - 1]) : 'rule_1';
      let versionObj: SemVer = { major: 1, minor: 1, patch: 0 };
      for (const val of values || []) {
        if (typeof val === 'string' && val.includes('"major"')) {
          try {
            versionObj = JSON.parse(val);
          } catch {
            // ignore
          }
        }
      }
      return {
        rows: [{
          id: ruleId,
          name: 'Updated Rule',
          description: 'Updated description',
          type: 'velocity',
          version: versionObj,
          severity: 'high',
          enabled: true,
          config: { window_minutes: 120 },
          created_at: new Date(),
          updated_at: new Date(),
        }]
      };
    }

    return { rows: [] };
  }

  release(): void {
    this.inTransaction = false;
    this.isReleased = true;
  }
}

describe('AMLRuleRepository', () => {
  let repository: AMLRuleRepository;
  let mockPool: MockPool;

  beforeEach(() => {
    mockPool = new MockPool();
    repository = new AMLRuleRepository(mockPool as unknown as Pool);
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
      expect(mockPool.client.isReleased).toBe(true);
      expect(mockPool.client.queries.some(q => q.text.includes('COMMIT'))).toBe(true);
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
      expect(mockPool.client.isReleased).toBe(true);
    });

    it('should rollback transaction and release client if error occurs during creation', async () => {
      mockPool.client.errorOnQueryText = 'INSERT INTO aml_rules';
      const input: CreateRuleInput = {
        name: 'Failing Rule',
        description: 'Fails to insert',
        type: 'velocity',
        severity: 'high',
        config: {},
      };

      await expect(repository.create(input, 'user_123'))
        .rejects.toThrow('Simulated database failure on: INSERT INTO aml_rules');

      expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
      expect(mockPool.client.isReleased).toBe(true);
      expect(mockPool.client.inTransaction).toBe(false);
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

    it('should return null for empty string rule ID', async () => {
      const rule = await repository.findById('');

      expect(rule).toBeNull();
    });

    it('should return null for whitespace rule ID', async () => {
      const rule = await repository.findById('   ');

      expect(rule).toBeNull();
    });

    it('should handle JSON stringified version and config correctly', async () => {
      const customClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'rule_json_test',
            name: 'Rule with stringified json',
            description: 'Test description',
            type: 'velocity',
            version: JSON.stringify({ major: 2, minor: 1, patch: 0 }),
            severity: 'high',
            enabled: true,
            config: JSON.stringify({ threshold: 500 }),
            created_at: new Date(),
            updated_at: new Date(),
          }]
        }),
      };
      const customPool = {
        connect: jest.fn().mockResolvedValue(customClient),
        query: customClient.query,
      };
      const repo = new AMLRuleRepository(customPool as unknown as Pool);

      const rule = await repo.findById('rule_json_test');

      expect(rule).toBeDefined();
      expect(rule?.version).toEqual({ major: 2, minor: 1, patch: 0 });
      expect(rule?.config).toEqual({ threshold: 500 });
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
    describe('normal paths', () => {
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
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.queries.some(q => q.text.includes('COMMIT'))).toBe(true);
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

        // When only metadata or enabled changes, minor is current.minor (0) and patch is current.patch + 1 (1)
        expect(rule.version.minor).toBe(0);
        expect(rule.version.patch).toBe(1);
      });

      it('should increment patch version when updating name or description only', async () => {
        const input: UpdateRuleInput = {
          name: 'New Name Only',
          description: 'New Description Only',
          change_reason: 'Update name and description only',
        };

        const rule = await repository.update('rule_1', input, 'user_123');

        expect(rule.version.minor).toBe(0);
        expect(rule.version.patch).toBe(1);
      });

      it('should increment patch version when input has no fields specified', async () => {
        const input: UpdateRuleInput = {
          change_reason: 'No changes except audit reason',
        };

        const rule = await repository.update('rule_1', input, 'user_123');

        expect(rule.version.minor).toBe(0);
        expect(rule.version.patch).toBe(1);
      });

      it('should record version history on update', async () => {
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update reason',
        };

        await repository.update('rule_1', input, 'user_456');

        const history = await repository.getVersionHistory('rule_1');
        expect(history.length).toBeGreaterThan(0);
        expect(mockPool.client.isReleased).toBe(true);
      });
    });

    describe('failure paths and boundary inputs (evidence src/aml/amlRuleRepository.ts:130)', () => {
      it('should throw explicit error and rollback when rule is not found', async () => {
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update',
        };

        await expect(repository.update('nonexistent', input, 'user_123'))
          .rejects.toThrow('Rule nonexistent not found');

        // Assert deterministic error and transactional rollback
        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.queries.some(q => q.text.includes('COMMIT'))).toBe(false);
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.inTransaction).toBe(false);
      });

      it('should throw explicit error when ruleId is empty string', async () => {
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update empty rule ID',
        };

        await expect(repository.update('', input, 'user_123'))
          .rejects.toThrow('Rule  not found');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId is whitespace only', async () => {
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update whitespace rule ID',
        };

        await expect(repository.update('   ', input, 'user_123'))
          .rejects.toThrow('Rule     not found');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId contains special characters', async () => {
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update special chars rule ID',
        };

        await expect(repository.update('rule/404#special!', input, 'user_123'))
          .rejects.toThrow('Rule rule/404#special! not found');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId is a non-existent UUID format', async () => {
        const nonExistentUuid = '00000000-0000-0000-0000-000000000000';
        const input: UpdateRuleInput = {
          name: 'Updated',
          change_reason: 'Update nonexistent UUID',
        };

        await expect(repository.update(nonExistentUuid, input, 'user_123'))
          .rejects.toThrow(`Rule ${nonExistentUuid} not found`);

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should rollback transaction and release client when query fails during update execution', async () => {
        mockPool.client.errorOnQueryText = 'UPDATE aml_rules';
        const input: UpdateRuleInput = {
          name: 'Should Fail During Update',
          change_reason: 'Simulated failure during update',
        };

        await expect(repository.update('rule_1', input, 'user_123'))
          .rejects.toThrow('Simulated database failure on: UPDATE aml_rules');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.inTransaction).toBe(false);
      });
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

    it('should correctly parse stringified JSON version and config in version history', async () => {
      const customClient = {
        query: jest.fn().mockResolvedValue({
          rows: [{
            id: 'history_json_test',
            rule_id: 'rule_1',
            version: JSON.stringify({ major: 1, minor: 2, patch: 3 }),
            config: JSON.stringify({ custom_field: 'value' }),
            enabled: true,
            changed_by: 'user_test',
            change_reason: 'Testing json parsing',
            created_at: new Date(),
          }]
        }),
      };
      const customPool = {
        connect: jest.fn().mockResolvedValue(customClient),
        query: customClient.query,
      };
      const repo = new AMLRuleRepository(customPool as unknown as Pool);

      const history = await repo.getVersionHistory('rule_1');

      expect(history).toHaveLength(1);
      expect(history[0].version).toEqual({ major: 1, minor: 2, patch: 3 });
      expect(history[0].config).toEqual({ custom_field: 'value' });
    });
  });

  describe('rollbackToVersion', () => {
    describe('normal paths', () => {
      it('should rollback to specific version and increment patch', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        const rule = await repository.rollbackToVersion('rule_1', targetVersion, 'user_123');

        expect(rule).toBeDefined();
        expect(rule.version.major).toBe(1);
        expect(rule.version.minor).toBe(0);
        expect(rule.version.patch).toBe(1);
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.queries.some(q => q.text.includes('COMMIT'))).toBe(true);
      });

      it('should record rollback in history with explicit audit reason', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await repository.rollbackToVersion('rule_1', targetVersion, 'user_123');

        const history = await repository.getVersionHistory('rule_1');
        expect(history.length).toBeGreaterThan(0);
        // Verify query recorded rollback version history
        const insertHistoryQuery = mockPool.client.queries.find(q =>
          q.text.includes('INSERT INTO aml_rule_version_history')
        );
        expect(insertHistoryQuery).toBeDefined();
        expect(insertHistoryQuery?.values).toContain('Rollback to version {"major":1,"minor":0,"patch":0}');
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should increment patch when rolling back to version with existing non-zero patch', async () => {
        const targetVersion: SemVer = { major: 1, minor: 2, patch: 3 };

        const rule = await repository.rollbackToVersion('rule_1', targetVersion, 'user_123');

        expect(rule).toBeDefined();
        expect(rule.version).toEqual({ major: 1, minor: 2, patch: 4 });
        expect(mockPool.client.isReleased).toBe(true);
      });
    });

    describe('failure paths and boundary inputs (evidence src/aml/amlRuleRepository.ts:236)', () => {
      it('should throw explicit error contract and rollback when version does not exist for rule', async () => {
        const targetVersion: SemVer = { major: 99, minor: 99, patch: 99 };

        await expect(repository.rollbackToVersion('rule_1', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":99,"minor":99,"patch":99} not found for rule rule_1');

        // Verify transaction was rolled back and client released
        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.queries.some(q => q.text.includes('COMMIT'))).toBe(false);
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.inTransaction).toBe(false);
      });

      it('should throw explicit error when version is boundary 0.0.0 and not found in history', async () => {
        const targetVersion: SemVer = { major: 0, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('rule_1', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":0,"minor":0,"patch":0} not found for rule rule_1');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when target version has negative values', async () => {
        const targetVersion: SemVer = { major: 0, minor: -1, patch: 0 };

        await expect(repository.rollbackToVersion('rule_1', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":0,"minor":-1,"patch":0} not found for rule rule_1');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId does not exist for rollback', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('nonexistent', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":1,"minor":0,"patch":0} not found for rule nonexistent');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId is empty string', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":1,"minor":0,"patch":0} not found for rule ');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId contains whitespace only', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('   ', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":1,"minor":0,"patch":0} not found for rule    ');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should throw explicit error when ruleId contains special characters', async () => {
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('rule@special#1', targetVersion, 'user_123'))
          .rejects.toThrow('Version {"major":1,"minor":0,"patch":0} not found for rule rule@special#1');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
      });

      it('should rollback transaction and release client when query fails during rollback execution', async () => {
        mockPool.client.errorOnQueryText = 'UPDATE aml_rules';
        const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

        await expect(repository.rollbackToVersion('rule_1', targetVersion, 'user_123'))
          .rejects.toThrow('Simulated database failure on: UPDATE aml_rules');

        expect(mockPool.client.queries.some(q => q.text.includes('ROLLBACK'))).toBe(true);
        expect(mockPool.client.isReleased).toBe(true);
        expect(mockPool.client.inTransaction).toBe(false);
      });
    });
  });
});
