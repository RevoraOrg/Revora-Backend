import * as fs from 'fs';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveMigrations } = require('./migrate.js');

describe('Database Migration Ordering and Collision Resolver', () => {
  describe('Mocked File List Assertions', () => {
    it('should successfully sort and resolve normal, sequential migrations', () => {
      const files = [
        '002_create_profiles.sql',
        '001_create_users.sql',
        '003_create_orders.sql',
      ];
      const result = resolveMigrations(files);
      expect(result).toEqual([
        '001_create_users.sql',
        '002_create_profiles.sql',
        '003_create_orders.sql',
      ]);
    });

    it('should ignore hidden files starting with a dot', () => {
      const files = [
        '.DS_Store',
        '002_create_profiles.sql',
        '001_create_users.sql',
        '.gitkeep',
      ];
      const result = resolveMigrations(files);
      expect(result).toEqual([
        '001_create_users.sql',
        '002_create_profiles.sql',
      ]);
    });

    it('should reject files missing a .sql extension by default', () => {
      const files = [
        '001_create_users.sql',
        '002_create_profiles.sql.bak',
      ];
      expect(() => {
        resolveMigrations(files);
      }).toThrow('Migration file lacks .sql extension');
    });

    it('should skip files missing a .sql extension when strictExtensions is false', () => {
      const files = [
        '001_create_users.sql',
        '002_create_profiles.sql.bak',
      ];
      const result = resolveMigrations(files, { strictExtensions: false });
      expect(result).toEqual([
        '001_create_users.sql',
      ]);
    });

    it('should reject files that lack a numeric prefix', () => {
      const files = [
        '001_create_users.sql',
        'create_profiles.sql',
      ];
      expect(() => {
        resolveMigrations(files);
      }).toThrow('Migration file name does not start with a numeric prefix');
    });

    it('should reject duplicate numeric prefixes by default (collision prevention)', () => {
      const files = [
        '001_create_users.sql',
        '001_create_audit_logs.sql',
      ];
      expect(() => {
        resolveMigrations(files);
      }).toThrow('Duplicate migration prefix detected: 001');
    });

    it('should allow duplicate numeric prefixes if allowDuplicates option is true', () => {
      const files = [
        '001_create_users.sql',
        '001_create_audit_logs.sql',
      ];
      const result = resolveMigrations(files, { allowDuplicates: true });
      expect(result).toEqual([
        '001_create_audit_logs.sql',
        '001_create_users.sql',
      ]);
    });

    it('should allow specific duplicate prefixes via allowedDuplicatePrefixes option', () => {
      const files = [
        '001_create_users.sql',
        '001_create_audit_logs.sql',
        '002_create_profiles.sql',
        '002_add_index.sql',
      ];
      const result = resolveMigrations(files, { allowedDuplicatePrefixes: ['001', '002'] });
      expect(result).toEqual([
        '001_create_audit_logs.sql',
        '001_create_users.sql',
        '002_add_index.sql',
        '002_create_profiles.sql',
      ]);
    });

    it('should reject duplicate prefixes not in allowedDuplicatePrefixes', () => {
      const files = [
        '001_create_users.sql',
        '001_create_audit_logs.sql',
      ];
      expect(() => {
        resolveMigrations(files, { allowedDuplicatePrefixes: ['002'] });
      }).toThrow('Duplicate migration prefix detected: 001');
    });

    it('should flag and reject 999_* as out-of-band by default', () => {
      const files = [
        '001_create_users.sql',
        '999_add_test_token.sql',
      ];
      expect(() => {
        resolveMigrations(files);
      }).toThrow('Out-of-band migration prefix 999 detected');
    });

    it('should allow 999_* if allowOutOfBand option is true', () => {
      const files = [
        '001_create_users.sql',
        '999_add_test_token.sql',
      ];
      const result = resolveMigrations(files, { allowOutOfBand: true });
      expect(result).toEqual([
        '001_create_users.sql',
        '999_add_test_token.sql',
      ]);
    });

    it('should reject non-monotonic ordering caused by non-padded numbers or incorrect sorting', () => {
      // Alphabetical sorting places "10_x" before "2_y".
      // But 10 > 2, so the sequence of prefixes [10, 2] is non-monotonic (strictly decreasing).
      const files = [
        '10_add_analytics.sql',
        '2_create_profiles.sql',
      ];
      expect(() => {
        resolveMigrations(files);
      }).toThrow('Non-monotonic migration ordering detected');
    });

    it('should allow non-monotonic ordering for prefixes in allowedDuplicatePrefixes', () => {
      // When a prefix is in the allowlist, we allow non-decreasing ordering (duplicates allowed)
      const files = [
        '001_create_users.sql',
        '001_create_audit_logs.sql',
        '002_create_profiles.sql',
      ];
      const result = resolveMigrations(files, { allowedDuplicatePrefixes: ['001'] });
      expect(result).toEqual([
        '001_create_audit_logs.sql',
        '001_create_users.sql',
        '002_create_profiles.sql',
      ]);
    });
  });

  describe('On-Disk Active Migration List Assertions', () => {
    it('should successfully validate the on-disk migrations directory with allowed legacy duplicates', () => {
      const migrationsDir = path.join(__dirname, 'migrations');
      expect(fs.existsSync(migrationsDir)).toBe(true);

      const allFiles = fs.readdirSync(migrationsDir);

      // The on-disk list must pass validation with the known legacy duplicate prefixes allowed.
      const LEGACY_DUPLICATE_PREFIXES = ['021', '025', '044', '060', '061'];
      const resolved = resolveMigrations(allFiles, {
        allowedDuplicatePrefixes: LEGACY_DUPLICATE_PREFIXES,
        strictExtensions: false,
      });

      expect(resolved.length).toBeGreaterThan(0);

      // Verify monotonic ordering (non-decreasing since duplicates are allowed)
      let lastPrefixNum = -1;
      for (const filename of resolved) {
        const match = filename.match(/^(\d+)_.*\.sql$/);
        expect(match).not.toBeNull();
        if (match) {
          const prefixNum = parseInt(match[1], 10);
          expect(prefixNum).toBeGreaterThanOrEqual(lastPrefixNum);
          lastPrefixNum = prefixNum;
        }
      }
    });

    it('should reject new duplicate prefixes beyond the legacy allowlist', () => {
      const migrationsDir = path.join(__dirname, 'migrations');
      expect(fs.existsSync(migrationsDir)).toBe(true);

      const allFiles = fs.readdirSync(migrationsDir);

      // Extract all prefixes from the real migration files
      const prefixes = new Set<string>();
      for (const filename of allFiles) {
        const match = filename.match(/^(\d+)_/);
        if (match) {
          prefixes.add(match[1]);
        }
      }

      // The only duplicates allowed are the legacy ones
      const LEGACY_DUPLICATE_PREFIXES = new Set(['021', '025', '044', '060', '061']);

      // Count occurrences of each prefix
      const prefixCounts = new Map<string, number>();
      for (const filename of allFiles) {
        const match = filename.match(/^(\d+)_/);
        if (match) {
          const prefix = match[1];
          prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
        }
      }

      // Check for duplicates outside the legacy allowlist
      const invalidDuplicates: string[] = [];
      for (const [prefix, count] of prefixCounts.entries()) {
        if (count > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix)) {
          invalidDuplicates.push(prefix);
        }
      }

      expect(invalidDuplicates).toEqual([]);
    });
  });
});