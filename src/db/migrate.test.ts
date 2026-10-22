import * as fs from 'fs';
import * as path from 'path';
const { resolveMigrations } = require('./migrate');

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
  });

  describe('On-Disk Active Migration List Assertions', () => {
    it('should successfully validate the on-disk migrations directory under strict rules', () => {
      const migrationsDir = path.join(__dirname, 'migrations');
      expect(fs.existsSync(migrationsDir)).toBe(true);

      const allFiles = fs.readdirSync(migrationsDir);
      
      // The on-disk list must pass strict validation with no duplicates or out-of-band prefixes.
      const resolved = resolveMigrations(allFiles);
      
      expect(resolved.length).toBeGreaterThan(0);
      
      let lastPrefixNum = -1;
      for (const filename of resolved) {
        const match = filename.match(/^(\d+)_.*\.sql$/);
        expect(match).not.toBeNull();
        if (match) {
          const prefixNum = parseInt(match[1], 10);
          expect(prefixNum).toBeGreaterThan(lastPrefixNum);
          lastPrefixNum = prefixNum;
        }
      }
    });
  });
});