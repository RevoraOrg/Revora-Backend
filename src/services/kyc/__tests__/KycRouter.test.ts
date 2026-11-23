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

  it('rejects a route to an unregistered provider until that provider is registered', () => {
    const unconfiguredRouter = new KycRouter(secretKey);
    unconfiguredRouter.loadRouteTable(signedTable('v1', [
      { jurisdiction: 'US', providerName: provider.name },
    ]));

    expect(() => unconfiguredRouter.route('US')).toThrow(
      'Configured provider null_provider not registered.',
    );

    unconfiguredRouter.registerProvider(provider);
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
});
