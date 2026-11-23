import crypto from 'crypto';
import { KycRouter, RouteTable, compareVersions, parseVersion } from '../KycRouter';
import { NullKycProvider } from '../providers/NullKycProvider';
import { ExistingVendorKycProvider } from '../providers/ExistingVendorKycProvider';
import { KycApplicantInfo } from '../KycProvider';

describe('KycRouter', () => {
  const secretKey = 'test-secret-key';
  let router: KycRouter;
  let nullProvider: NullKycProvider;
  let vendorProvider: ExistingVendorKycProvider;

  beforeEach(() => {
    router = new KycRouter(secretKey);
    nullProvider = new NullKycProvider();
    vendorProvider = new ExistingVendorKycProvider();

    router.registerProvider(nullProvider);
    router.registerProvider(vendorProvider);
  });

  const createSignedTable = (
    version: string,
    entries: { jurisdiction: string; providerName: string }[],
    key = secretKey
  ): RouteTable => {
    const payload = JSON.stringify({ version, entries });
    const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
    return { version, entries, signature };
  };

  describe('Basic routing and signature verification', () => {
    it('fails closed when route table signature is invalid', () => {
      const table: RouteTable = {
        version: '1.0.0',
        entries: [{ jurisdiction: 'US', providerName: 'null_provider' }],
        signature: 'invalid_signature',
      };

      expect(() => router.loadRouteTable(table)).toThrow('Invalid route table signature. Fails closed.');
    });

    it('loads valid initial route table and routes correctly', () => {
      const table = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
        { jurisdiction: 'EU', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(table);

      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(nullProvider);
      expect(router.route('EU')).toBe(vendorProvider);
    });

    it('fails closed for unknown jurisdictions', () => {
      const table = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      router.loadRouteTable(table);

      expect(() => router.route('CA')).toThrow('Jurisdiction CA not supported. Fails closed.');
    });

    it('fails if the configured provider is not registered', () => {
      const table = createSignedTable('1.0.0', [
        { jurisdiction: 'JP', providerName: 'unregistered_provider' },
      ]);
      router.loadRouteTable(table);

      expect(() => router.route('JP')).toThrow('Configured provider unregistered_provider not registered.');
    });

    it('executes provider methods via routing', async () => {
      const table = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      router.loadRouteTable(table);

      const provider = router.route('US');
      const mockApplicant: KycApplicantInfo = {
        firstName: 'Jane',
        lastName: 'Doe',
        email: 'jane@example.com',
        dateOfBirth: '1992-05-10',
        address: {
          country: 'US',
          line1: '456 Elm St',
          city: 'Metropolis',
          postalCode: '67890',
        },
      };

      const result = await provider.initiateCheck('investor-456', mockApplicant);
      expect(result.provider).toBe('null_provider');
      expect(result.status).toBe('pending');
    });
  });

  describe('Route table version upgrade scenarios', () => {
    it('accepts an upgrade and updates getVersion()', () => {
      const v1 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      const v2 = createSignedTable('1.1.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1);
      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(nullProvider);

      router.loadRouteTable(v2);
      expect(router.getVersion()).toBe('1.1.0');
      expect(router.route('US')).toBe(vendorProvider);
    });

    it('handles numeric multi-digit segment upgrades (e.g. 1.2 to 1.10)', () => {
      const v1 = createSignedTable('1.2.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      const v2 = createSignedTable('1.10.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1);
      router.loadRouteTable(v2);

      expect(router.getVersion()).toBe('1.10.0');
      expect(router.route('US')).toBe(vendorProvider);
    });

    it('handles two-part version upgrades (e.g. 1.0 to 1.1)', () => {
      const v1 = createSignedTable('1.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      const v2 = createSignedTable('1.1', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1);
      router.loadRouteTable(v2);

      expect(router.getVersion()).toBe('1.1');
    });

    it('handles major version bumps (e.g. 1.9.9 to 2.0.0)', () => {
      const v1 = createSignedTable('1.9.9', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      const v2 = createSignedTable('2.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1);
      router.loadRouteTable(v2);

      expect(router.getVersion()).toBe('2.0.0');
    });

    it('handles pre-release to release upgrades (e.g. 1.0.0-rc.1 to 1.0.0)', () => {
      const v1 = createSignedTable('1.0.0-rc.1', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      const v2 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1);
      router.loadRouteTable(v2);

      expect(router.getVersion()).toBe('1.0.0');
    });
  });

  describe('Same-version (replay) rejection scenarios', () => {
    it('rejects loading the identical version by default and logs a warning with both versions', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const v1 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      router.loadRouteTable(v1);

      // Re-submitting same version 1.0.0 with different provider
      const replay = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      expect(() => router.loadRouteTable(replay)).toThrow(/cannot load version 1\.0\.0 over 1\.0\.0|not newer than current version "1\.0\.0"/);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0][0];
      expect(warnMessage).toContain('1.0.0');

      // State is preserved
      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(nullProvider);

      warnSpy.mockRestore();
    });

    it('rejects loading equivalent numeric version (e.g. 1.0 over 1.0.0)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const v1 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      router.loadRouteTable(v1);

      const equivalent = createSignedTable('1.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      expect(() => router.loadRouteTable(equivalent)).toThrow();
      expect(warnSpy).toHaveBeenCalled();
      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(nullProvider);

      warnSpy.mockRestore();
    });
  });

  describe('Downgrade rejection scenarios', () => {
    it('rejects an older version by default and logs a warning with both versions', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const v2 = createSignedTable('2.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);
      router.loadRouteTable(v2);

      const olderTable = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);

      expect(() => router.loadRouteTable(olderTable)).toThrow(/cannot load version 1\.0\.0 over 2\.0\.0|not newer than current version "2\.0\.0"/);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0][0];
      expect(warnMessage).toContain('1.0.0');
      expect(warnMessage).toContain('2.0.0');

      // Routing state preserved
      expect(router.getVersion()).toBe('2.0.0');
      expect(router.route('US')).toBe(vendorProvider);

      warnSpy.mockRestore();
    });

    it('rejects minor version downgrade (e.g. 1.1.0 over 1.2.0)', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const v12 = createSignedTable('1.2.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);
      router.loadRouteTable(v12);

      const v11 = createSignedTable('1.1.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);

      expect(() => router.loadRouteTable(v11)).toThrow();
      expect(warnSpy).toHaveBeenCalled();
      expect(router.getVersion()).toBe('1.2.0');

      warnSpy.mockRestore();
    });
  });

  describe('allowDowngrade override scenarios', () => {
    it('allows loading an older version when allowDowngrade is true', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const v2 = createSignedTable('2.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);
      router.loadRouteTable(v2);

      const v1 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);

      // Explicitly allow downgrade
      router.loadRouteTable(v1, { allowDowngrade: true });

      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(nullProvider);

      warnSpy.mockRestore();
    });

    it('allows reloading the same version when allowDowngrade is true', () => {
      const v1 = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);
      router.loadRouteTable(v1);

      const v1Updated = createSignedTable('1.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);

      router.loadRouteTable(v1Updated, { allowDowngrade: true });

      expect(router.getVersion()).toBe('1.0.0');
      expect(router.route('US')).toBe(vendorProvider);
    });
  });

  describe('Signature check priority and invalid inputs', () => {
    it('rejects invalid signature before evaluating version', () => {
      const v2 = createSignedTable('2.0.0', [
        { jurisdiction: 'US', providerName: 'existing_vendor' },
      ]);
      router.loadRouteTable(v2);

      const badSigTable: RouteTable = {
        version: '1.0.0', // Older version
        entries: [{ jurisdiction: 'US', providerName: 'null_provider' }],
        signature: 'tampered-signature',
      };

      // Must fail with signature error, not version error
      expect(() => router.loadRouteTable(badSigTable)).toThrow('Invalid route table signature. Fails closed.');
    });

    it('rejects invalid/malformed version strings', () => {
      const badTable = createSignedTable('invalid-version', [
        { jurisdiction: 'US', providerName: 'null_provider' },
      ]);

      expect(() => router.loadRouteTable(badTable)).toThrow(/Invalid version format/);
    });
  });

  describe('Version comparison helper functions', () => {
    it('parses valid versions correctly', () => {
      expect(parseVersion('1')).toEqual({ numbers: [1], prerelease: undefined });
      expect(parseVersion('1.0')).toEqual({ numbers: [1, 0], prerelease: undefined });
      expect(parseVersion('1.2.3')).toEqual({ numbers: [1, 2, 3], prerelease: undefined });
      expect(parseVersion('v2.0.1')).toEqual({ numbers: [2, 0, 1], prerelease: undefined });
      expect(parseVersion('2026.09-regression')).toEqual({ numbers: [2026, 9], prerelease: ['regression'] });
    });

    it('compares versions accurately', () => {
      expect(compareVersions('1.1.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
      expect(compareVersions('2026.10', '2026.09')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    });

    it('throws on empty or non-string version input', () => {
      expect(() => parseVersion('')).toThrow();
      expect(() => parseVersion('   ')).toThrow();
      expect(() => parseVersion('not.a.version')).toThrow();
    });
  });
});
