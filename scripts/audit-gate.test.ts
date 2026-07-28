import { checkVulnerabilities, checkOutdated, validateOverride } from './audit-gate';
import fs from 'fs';
import path from 'path';

jest.mock('fs');

describe('audit-gate', () => {
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const pastDate = new Date(Date.now() - 86400000).toISOString();

  describe('validateOverride', () => {
    it('returns error if expired', () => {
      const err = validateOverride('pkg', { expiry: pastDate, ticket: 'T-1' });
      expect(err).toContain('has expired');
    });

    it('returns error if missing justification/ticket', () => {
      const err = validateOverride('pkg', { expiry: futureDate });
      expect(err).toContain('must have a ticket or justification');
    });

    it('passes valid override', () => {
      const err = validateOverride('pkg', { expiry: futureDate, justification: 'reason' });
      expect(err).toBeNull();
    });
  });

  describe('checkVulnerabilities', () => {
    const allowlist = {
      vulnerabilities: {
        'allowed-vuln': { expiry: futureDate, ticket: 'T-1' },
        'expired-vuln': { expiry: pastDate, ticket: 'T-2' }
      },
      outdated: {}
    };

    it('catches unallowed vulnerability', () => {
      const auditJson = JSON.stringify({
        vulnerabilities: {
          'bad-pkg': { severity: 'high' }
        }
      });
      const errors = checkVulnerabilities(auditJson, allowlist);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Vulnerability found: bad-pkg');
    });

    it('ignores allowed valid vulnerability', () => {
      const auditJson = JSON.stringify({
        vulnerabilities: {
          'allowed-vuln': { severity: 'high' }
        }
      });
      const errors = checkVulnerabilities(auditJson, allowlist);
      expect(errors).toHaveLength(0);
    });

    it('fails on expired override', () => {
      const auditJson = JSON.stringify({
        vulnerabilities: {
          'expired-vuln': { severity: 'high' }
        }
      });
      const errors = checkVulnerabilities(auditJson, allowlist);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('has expired');
    });

    it('ignores transitive only via dev implicitly (if omitted from json)', () => {
      // If npm audit --omit=dev doesn't output it, it's not in the JSON.
      const auditJson = JSON.stringify({ vulnerabilities: {} });
      const errors = checkVulnerabilities(auditJson, allowlist);
      expect(errors).toHaveLength(0);
    });
  });

  describe('checkOutdated', () => {
    const allowlist = {
      vulnerabilities: {},
      outdated: {
        'allowed-outdated': { expiry: futureDate, ticket: 'T-1' }
      }
    };

    beforeEach(() => {
      (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
        dependencies: {
          'bad-outdated': '1.0.0',
          'allowed-outdated': '1.0.0'
        },
        devDependencies: {
          'dev-outdated': '1.0.0'
        }
      }));
    });

    it('catches unallowed prod outdated dependency', () => {
      const outdatedJson = JSON.stringify({
        'bad-outdated': { wanted: '1.0.0', latest: '2.0.0' }
      });
      const errors = checkOutdated(outdatedJson, allowlist, 'pkg.json');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Critical dependency outdated: bad-outdated');
    });

    it('ignores allowed prod outdated dependency', () => {
      const outdatedJson = JSON.stringify({
        'allowed-outdated': { wanted: '1.0.0', latest: '2.0.0' }
      });
      const errors = checkOutdated(outdatedJson, allowlist, 'pkg.json');
      expect(errors).toHaveLength(0);
    });

    it('ignores dev dependency outdated (not critical)', () => {
      const outdatedJson = JSON.stringify({
        'dev-outdated': { wanted: '1.0.0', latest: '2.0.0' }
      });
      const errors = checkOutdated(outdatedJson, allowlist, 'pkg.json');
      expect(errors).toHaveLength(0);
    });
  });
});
