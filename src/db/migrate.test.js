"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fs = require("fs");
var path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
var resolveMigrations = require('./migrate.js').resolveMigrations;
describe('Database Migration Ordering and Collision Resolver', function () {
    describe('Mocked File List Assertions', function () {
        it('should successfully sort and resolve normal, sequential migrations', function () {
            var files = [
                '002_create_profiles.sql',
                '001_create_users.sql',
                '003_create_orders.sql',
            ];
            var result = resolveMigrations(files);
            expect(result).toEqual([
                '001_create_users.sql',
                '002_create_profiles.sql',
                '003_create_orders.sql',
            ]);
        });
        it('should ignore hidden files starting with a dot', function () {
            var files = [
                '.DS_Store',
                '002_create_profiles.sql',
                '001_create_users.sql',
                '.gitkeep',
            ];
            var result = resolveMigrations(files);
            expect(result).toEqual([
                '001_create_users.sql',
                '002_create_profiles.sql',
            ]);
        });
        it('should reject files missing a .sql extension by default', function () {
            var files = [
                '001_create_users.sql',
                '002_create_profiles.sql.bak',
            ];
            expect(function () {
                resolveMigrations(files);
            }).toThrow('Migration file lacks .sql extension');
        });
        it('should skip files missing a .sql extension when strictExtensions is false', function () {
            var files = [
                '001_create_users.sql',
                '002_create_profiles.sql.bak',
            ];
            var result = resolveMigrations(files, { strictExtensions: false });
            expect(result).toEqual([
                '001_create_users.sql',
            ]);
        });
        it('should reject files that lack a numeric prefix', function () {
            var files = [
                '001_create_users.sql',
                'create_profiles.sql',
            ];
            expect(function () {
                resolveMigrations(files);
            }).toThrow('Migration file name does not start with a numeric prefix');
        });
        it('should reject duplicate numeric prefixes by default (collision prevention)', function () {
            var files = [
                '001_create_users.sql',
                '001_create_audit_logs.sql',
            ];
            expect(function () {
                resolveMigrations(files);
            }).toThrow('Duplicate migration prefix detected: 001');
        });
        it('should allow duplicate numeric prefixes if allowDuplicates option is true', function () {
            var files = [
                '001_create_users.sql',
                '001_create_audit_logs.sql',
            ];
            var result = resolveMigrations(files, { allowDuplicates: true });
            expect(result).toEqual([
                '001_create_audit_logs.sql',
                '001_create_users.sql',
            ]);
        });
        it('should allow specific duplicate prefixes via allowedDuplicatePrefixes option', function () {
            var files = [
                '001_create_users.sql',
                '001_create_audit_logs.sql',
                '002_create_profiles.sql',
                '002_add_index.sql',
            ];
            var result = resolveMigrations(files, { allowedDuplicatePrefixes: ['001', '002'] });
            expect(result).toEqual([
                '001_create_audit_logs.sql',
                '001_create_users.sql',
                '002_add_index.sql',
                '002_create_profiles.sql',
            ]);
        });
        it('should reject duplicate prefixes not in allowedDuplicatePrefixes', function () {
            var files = [
                '001_create_users.sql',
                '001_create_audit_logs.sql',
            ];
            expect(function () {
                resolveMigrations(files, { allowedDuplicatePrefixes: ['002'] });
            }).toThrow('Duplicate migration prefix detected: 001');
        });
        it('should flag and reject 999_* as out-of-band by default', function () {
            var files = [
                '001_create_users.sql',
                '999_add_test_token.sql',
            ];
            expect(function () {
                resolveMigrations(files);
            }).toThrow('Out-of-band migration prefix 999 detected');
        });
        it('should allow 999_* if allowOutOfBand option is true', function () {
            var files = [
                '001_create_users.sql',
                '999_add_test_token.sql',
            ];
            var result = resolveMigrations(files, { allowOutOfBand: true });
            expect(result).toEqual([
                '001_create_users.sql',
                '999_add_test_token.sql',
            ]);
        });
        it('should reject non-monotonic ordering caused by non-padded numbers or incorrect sorting', function () {
            // Alphabetical sorting places "10_x" before "2_y".
            // But 10 > 2, so the sequence of prefixes [10, 2] is non-monotonic (strictly decreasing).
            var files = [
                '10_add_analytics.sql',
                '2_create_profiles.sql',
            ];
            expect(function () {
                resolveMigrations(files);
            }).toThrow('Non-monotonic migration ordering detected');
        });
        it('should allow non-monotonic ordering for prefixes in allowedDuplicatePrefixes', function () {
            // When a prefix is in the allowlist, we allow non-decreasing ordering (duplicates allowed)
            var files = [
                '001_create_users.sql',
                '001_create_audit_logs.sql',
                '002_create_profiles.sql',
            ];
            var result = resolveMigrations(files, { allowedDuplicatePrefixes: ['001'] });
            expect(result).toEqual([
                '001_create_audit_logs.sql',
                '001_create_users.sql',
                '002_create_profiles.sql',
            ]);
        });
    });
    describe('On-Disk Active Migration List Assertions', function () {
        it('should successfully validate the on-disk migrations directory with allowed legacy duplicates', function () {
            var migrationsDir = path.join(__dirname, 'migrations');
            expect(fs.existsSync(migrationsDir)).toBe(true);
            var allFiles = fs.readdirSync(migrationsDir);
            // The on-disk list must pass validation with the known legacy duplicate prefixes allowed.
            var LEGACY_DUPLICATE_PREFIXES = ['021', '025', '044', '060', '061'];
            var resolved = resolveMigrations(allFiles, {
                allowedDuplicatePrefixes: LEGACY_DUPLICATE_PREFIXES,
                strictExtensions: false,
            });
            expect(resolved.length).toBeGreaterThan(0);
            // Verify monotonic ordering (non-decreasing since duplicates are allowed)
            var lastPrefixNum = -1;
            for (var _i = 0, resolved_1 = resolved; _i < resolved_1.length; _i++) {
                var filename = resolved_1[_i];
                var match = filename.match(/^(\d+)_.*\.sql$/);
                expect(match).not.toBeNull();
                if (match) {
                    var prefixNum = parseInt(match[1], 10);
                    expect(prefixNum).toBeGreaterThanOrEqual(lastPrefixNum);
                    lastPrefixNum = prefixNum;
                }
            }
        });
        it('should reject new duplicate prefixes beyond the legacy allowlist', function () {
            var migrationsDir = path.join(__dirname, 'migrations');
            expect(fs.existsSync(migrationsDir)).toBe(true);
            var allFiles = fs.readdirSync(migrationsDir);
            // Extract all prefixes from the real migration files
            var prefixes = new Set();
            for (var _i = 0, allFiles_1 = allFiles; _i < allFiles_1.length; _i++) {
                var filename = allFiles_1[_i];
                var match = filename.match(/^(\d+)_/);
                if (match) {
                    prefixes.add(match[1]);
                }
            }
            // The only duplicates allowed are the legacy ones
            var LEGACY_DUPLICATE_PREFIXES = new Set(['021', '025', '044', '060', '061']);
            // Count occurrences of each prefix
            var prefixCounts = new Map();
            for (var _a = 0, allFiles_2 = allFiles; _a < allFiles_2.length; _a++) {
                var filename = allFiles_2[_a];
                var match = filename.match(/^(\d+)_/);
                if (match) {
                    var prefix = match[1];
                    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
                }
            }
            // Check for duplicates outside the legacy allowlist
            var invalidDuplicates = [];
            for (var _b = 0, _c = prefixCounts.entries(); _b < _c.length; _b++) {
                var _d = _c[_b], prefix = _d[0], count = _d[1];
                if (count > 1 && !LEGACY_DUPLICATE_PREFIXES.has(prefix)) {
                    invalidDuplicates.push(prefix);
                }
            }
            expect(invalidDuplicates).toEqual([]);
        });
    });
});
