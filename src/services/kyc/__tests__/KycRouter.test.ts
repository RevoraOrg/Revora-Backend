import crypto from 'crypto';
import { KycRouter, type RouteTable, type RouteTableEntry } from '../KycRouter';
import { NullKycProvider } from '../providers/NullKycProvider';

const secretKey = 'kyc-router-test-key';

function signedTable(
  version: string,
  entries: RouteTableEntry[],
  key = secretKey,
): RouteTable {
  const payload = JSON.stringify({ version, entries });
  return {
    version,
    entries,
    signature: crypto.createHmac('sha256', key).update(payload).digest('hex'),
  };
}

describe('KycRouter', () => {
  let router: KycRouter;
  let provider: NullKycProvider;

  beforeEach(() => {
    router = new KycRouter(secretKey);
    provider = new NullKycProvider();
    router.registerProvider(provider);
  });

  it('starts without a version and fails closed before a table is loaded', () => {
    expect(router.getVersion()).toBe('');
    expect(() => router.route('US')).toThrow(
      'Jurisdiction US not supported. Fails closed.',
    );
  });

  it('loads a valid signature and returns the registered provider for each route', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
      { jurisdiction: 'CA', providerName: provider.name },
    ]));

    expect(router.getVersion()).toBe('v1');
    expect(router.route('US')).toBe(provider);
    expect(router.route('CA')).toBe(provider);
  });

  it.each(['GB', 'us', ''])('fails closed for unsupported jurisdiction %j', (jurisdiction) => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));

    expect(() => router.route(jurisdiction)).toThrow(
      `Jurisdiction ${jurisdiction} not supported. Fails closed.`,
    );
  });

  it('rejects a table that references an unregistered provider without installing it', () => {
    const unconfiguredRouter = new KycRouter(secretKey);
    const table = signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]);

    expect(() => unconfiguredRouter.loadRouteTable(table)).toThrow(
      `references unregistered provider "${provider.name}"`,
    );
    expect(unconfiguredRouter.getVersion()).toBe('');
    expect(() => unconfiguredRouter.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');

    // Once the provider is registered the same table loads and routes.
    unconfiguredRouter.registerProvider(provider);
    unconfiguredRouter.loadRouteTable(table);
    expect(unconfiguredRouter.route('US')).toBe(provider);
  });

  it.each([
    ['changed jurisdiction', (table: RouteTable) => {
      table.entries[0].jurisdiction = 'GB';
    }],
    ['changed provider', (table: RouteTable) => {
      table.entries[0].providerName = 'untrusted_provider';
    }],
    ['added entry', (table: RouteTable) => {
      table.entries.push({ jurisdiction: 'GB', providerName: 'untrusted_provider' });
    }],
    ['changed version', (table: RouteTable) => {
      table.version = 'forged';
    }],
    ['wrong signing key', (table: RouteTable) => {
      table.signature = signedTable(table.version, table.entries, 'wrong-key').signature;
    }],
    ['missing signature', (table: RouteTable) => {
      table.signature = '';
    }],
  ] satisfies Array<[string, (table: RouteTable) => void]>)(
    'rejects %s without replacing the active routes or version',
    (_description, tamper) => {
      router.loadRouteTable(signedTable('v1', [
        { jurisdiction: 'US', providerName: provider.name },
      ]));
      const replacement = signedTable('v2', [
        { jurisdiction: 'CA', providerName: provider.name },
      ]);
      tamper(replacement);

      expect(() => router.loadRouteTable(replacement)).toThrow(
        'Invalid route table signature. Fails closed.',
      );
      expect(router.getVersion()).toBe('v1');
      expect(router.route('US')).toBe(provider);
      expect(() => router.route('CA')).toThrow('Jurisdiction CA not supported. Fails closed.');
      expect(() => router.route('GB')).toThrow('Jurisdiction GB not supported. Fails closed.');
    },
  );

  it.each([
    ['non-hex characters', (signature: string) => `z${signature.slice(1)}`],
    ['a short (wrong-length) signature', (signature: string) => signature.slice(0, 32)],
    ['a long (wrong-length) signature', (signature: string) => `${signature}00`],
    ['an empty signature', () => ''],
  ] satisfies Array<[string, (signature: string) => string]>)(
    'fails closed with the same error for %s',
    (_description, corrupt) => {
      const table = signedTable('v1', [
        { jurisdiction: 'US', providerName: provider.name },
      ]);
      table.signature = corrupt(table.signature);

      // A malformed signature must fail closed with the documented error, not
      // leak a RangeError from timingSafeEqual's length check.
      expect(() => router.loadRouteTable(table)).toThrow(
        'Invalid route table signature. Fails closed.',
      );
      expect(router.getVersion()).toBe('');
      expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
    },
  );


  it('keeps an initially invalid table from installing any routes or version', () => {
    const table = signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ], 'wrong-key');

    expect(() => router.loadRouteTable(table)).toThrow(
      'Invalid route table signature. Fails closed.',
    );
    expect(router.getVersion()).toBe('');
    expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
  });

  it('replaces old entries and updates the version on a valid reload', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));
    router.loadRouteTable(signedTable('v2', [
      { jurisdiction: 'CA', providerName: provider.name },
    ]));

    expect(router.getVersion()).toBe('v2');
    expect(router.route('CA')).toBe(provider);
    expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
  });

  it('accepts a signed empty table that clears all routes', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));
    router.loadRouteTable(signedTable('v2', []));

    expect(router.getVersion()).toBe('v2');
    expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
  });

  it('rejects duplicate jurisdictions and keeps the previous table active', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));

    const duplicate = signedTable('v2', [
      { jurisdiction: 'US', providerName: provider.name },
      { jurisdiction: 'US', providerName: provider.name },
    ]);

    expect(() => router.loadRouteTable(duplicate)).toThrow('duplicate jurisdiction "US"');
    expect(router.getVersion()).toBe('v1');
    expect(router.route('US')).toBe(provider);
  });

  it('treats jurisdictions case-insensitively when detecting duplicates', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));

    const duplicate = signedTable('v2', [
      { jurisdiction: 'us', providerName: provider.name },
      { jurisdiction: 'US', providerName: provider.name },
    ]);

    expect(() => router.loadRouteTable(duplicate)).toThrow('duplicate jurisdiction "US"');
    expect(router.getVersion()).toBe('v1');
  });

  it('normalises lower-case jurisdictions so they still route', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'us', providerName: provider.name },
      { jurisdiction: 'ca', providerName: provider.name },
    ]));

    // `src/routes/kyc.ts` upper-cases the applicant country before routing.
    expect(router.route('US')).toBe(provider);
    expect(router.route('CA')).toBe(provider);
  });

  it('keeps the active table when a reload references an unregistered provider', () => {
    router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));

    const bad = signedTable('v2', [
      { jurisdiction: 'CA', providerName: 'ghost_provider' },
    ]);

    expect(() => router.loadRouteTable(bad)).toThrow(
      'references unregistered provider "ghost_provider"',
    );
    expect(router.getVersion()).toBe('v1');
    expect(router.route('US')).toBe(provider);
    expect(() => router.route('CA')).toThrow('Jurisdiction CA not supported. Fails closed.');
  });

  it('rejects entries with a missing jurisdiction or providerName', () => {
    expect(() => router.loadRouteTable(signedTable('v1', [
      { jurisdiction: '', providerName: provider.name },
    ]))).toThrow('requires a non-empty jurisdiction');
    expect(router.getVersion()).toBe('');

    expect(() => router.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: '' },
    ]))).toThrow('requires a non-empty providerName');
    expect(router.getVersion()).toBe('');
  });
});
