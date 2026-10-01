/**
 * Regression coverage for `RouteTableEntry` failure handling (Issue #1102).
 *
 * The router is a security boundary: a tampered route table, an unmapped
 * jurisdiction, or a misconfigured provider must fail closed with a thrown
 * error instead of silently degrading to a default provider.
 *
 * Evidence branches exercised (src/services/kyc/KycRouter.ts):
 *   - L41: `throw new Error('Invalid route table signature. Fails closed.')`
 *   - L58: `throw new Error(\`Jurisdiction ${jurisdiction} not supported. Fails closed.\`)`
 *   - L63: `throw new Error(\`Configured provider ${providerName} not registered.\`)`
 *
 * Each failure branch is paired with its neighbouring success path so the suite
 * pins the *branch*, not merely the throw. All inputs are deterministic (no
 * clock, no network, no randomness) and the public contract is asserted without
 * being modified.
 */

import crypto from 'crypto';
import {
  KycRouter,
  RouteTable,
  RouteTableEntry,
} from '../KycRouter';
import type {
  KycProvider,
  KycApplicantInfo,
  KycCheckResult,
} from '../KycProvider';

// ─── Test doubles ─────────────────────────────────────────────────────────────

const SECRET_KEY = 'route-table-regression-secret';
const VERSION = '2026.09-regression';
const PASSPORT_APPLICANT: KycApplicantInfo = {
  firstName: 'Regression',
  lastName: 'Case',
  email: 'regression.route-table@example.test',
  dateOfBirth: '1990-01-01',
  address: {
    country: 'US',
    line1: '1 Regression Way',
    city: 'Testville',
    postalCode: '00000',
  },
};

/**
 * Minimal deterministic provider double. Avoids coupling the regression suite
 * to the concrete NullKycProvider / ExistingVendorKycProvider implementations
 * (their behavior is covered by their own suites).
 */
function makeProvider(name: string): KycProvider {
  const result: KycCheckResult = {
    status: 'pending',
    provider: name,
    referenceId: `ref-${name}`,
  };
  return {
    name,
    initiateCheck: jest.fn().mockResolvedValue(result),
    getStatus: jest.fn().mockResolvedValue(result),
    handleWebhook: jest.fn().mockResolvedValue(result),
  };
}

/** Signs a route table exactly as production does (HMAC-SHA256 over the payload). */
function signTable(version: string, entries: RouteTableEntry[], key = SECRET_KEY): RouteTable {
  const payload = JSON.stringify({ version, entries });
  const signature = crypto.createHmac('sha256', key).update(payload).digest('hex');
  return { version, entries, signature };
}

/**
 * Builds a router with the named providers registered and the given (signed)
 * table loaded. Isolates each test from cross-test registry state.
 */
function buildRouter(
  entries: RouteTableEntry[],
  providerNames: string[] = [],
  table: RouteTable = signTable(VERSION, entries)
): KycRouter {
  const router = new KycRouter(SECRET_KEY);
  for (const name of providerNames) {
    router.registerProvider(makeProvider(name));
  }
  router.loadRouteTable(table);
  return router;
}

// ─── Branch 1: signature verification (L41) ──────────────────────────────────

describe('KycRouter RouteTableEntry regression — signature verification (fails closed)', () => {
  it('throws and leaves routing inoperable when the signature is tampered', () => {
    const entries: RouteTableEntry[] = [{ jurisdiction: 'US', providerName: 'provider-a' }];
    const table = signTable(VERSION, entries);
    // Simulate an attacker flipping one entry after signing.
    table.entries = [{ jurisdiction: 'US', providerName: 'provider-evil' }];

    expect(() => new KycRouter(SECRET_KEY).loadRouteTable(table)).toThrow(
      'Invalid route table signature. Fails closed.'
    );
  });

  it('rejects a signature produced with a different secret key (key confusion)', () => {
    const table = signTable(VERSION, [{ jurisdiction: 'US', providerName: 'provider-a' }], 'attacker-key');

    expect(() => new KycRouter(SECRET_KEY).loadRouteTable(table)).toThrow(
      'Invalid route table signature. Fails closed.'
    );
  });

  it('rejects a garbage signature without throwing anything but the documented error', () => {
    const table: RouteTable = {
      version: VERSION,
      entries: [{ jurisdiction: 'US', providerName: 'provider-a' }],
      signature: 'deadbeef',
    };

    let thrown: unknown;
    try {
      new KycRouter(SECRET_KEY).loadRouteTable(table);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid route table signature. Fails closed.');
    // Contract pin: signature errors are plain Errors, not a more specific class.
    expect((thrown as Error).constructor.name).toBe('Error');
  });

  it('treats an empty-entries table signed correctly as valid (legal boundary input)', () => {
    const router = new KycRouter(SECRET_KEY);
    const emptyEntries: RouteTableEntry[] = [];
    router.loadRouteTable(signTable(VERSION, emptyEntries));

    // Version advances even though no routes exist.
    expect(router.getVersion()).toBe(VERSION);
    // Every jurisdiction now fails closed (map was cleared and not repopulated).
    expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
  });

  it('fails closed on a validly signed table whose entries were reordered after signing', () => {
    const original = signTable(VERSION, [
      { jurisdiction: 'US', providerName: 'provider-a' },
      { jurisdiction: 'EU', providerName: 'provider-b' },
    ]);
    const reordered: RouteTable = {
      version: original.version,
      entries: [...original.entries].reverse(),
      signature: original.signature,
    };

    expect(() => new KycRouter(SECRET_KEY).loadRouteTable(reordered)).toThrow(
      'Invalid route table signature. Fails closed.'
    );
  });
});

// ─── Branch 2: unknown jurisdiction (L58) ────────────────────────────────────

describe('KycRouter RouteTableEntry regression — unknown jurisdiction (fails closed)', () => {
  it('throws the documented error for an unmapped jurisdiction', () => {
    const router = buildRouter([{ jurisdiction: 'US', providerName: 'provider-a' }], ['provider-a']);

    expect(() => router.route('CA')).toThrow('Jurisdiction CA not supported. Fails closed.');
  });

  it('surfaces the offending jurisdiction verbatim in the error message', () => {
    const router = buildRouter([{ jurisdiction: 'US', providerName: 'provider-a' }], ['provider-a']);
    const unsupported = 'ZZ';

    expect(() => router.route(unsupported)).toThrow(
      `Jurisdiction ${unsupported} not supported. Fails closed.`
    );
  });

  it('fails closed for adversarial jurisdiction inputs (case, whitespace, empty string)', () => {
    const router = buildRouter([{ jurisdiction: 'US', providerName: 'provider-a' }], ['provider-a']);

    expect(() => router.route('us')).toThrow('Jurisdiction us not supported. Fails closed.');
    expect(() => router.route(' US ')).toThrow('Jurisdiction  US  not supported. Fails closed.');
    expect(() => router.route('')).toThrow('Jurisdiction  not supported. Fails closed.');
  });

  it('fails closed after a version bump that dropped the jurisdiction (stale-client boundary)', () => {
    // v1 maps US → provider-a; v2 removes US entirely.
    const v1 = buildRouter([{ jurisdiction: 'US', providerName: 'provider-a' }], ['provider-a']);
    const v2 = buildRouter([], ['provider-a'], signTable('2026.10-regression', []));

    expect(() => v1.route('US')).not.toThrow();
    expect(() => v2.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
    expect(v2.getVersion()).toBe('2026.10-regression');
  });

  it('preserves the success path for a mapped jurisdiction (neighbouring normal path)', () => {
    const providerA = makeProvider('provider-a');
    const router = new KycRouter(SECRET_KEY);
    router.registerProvider(providerA);
    router.loadRouteTable(signTable(VERSION, [{ jurisdiction: 'US', providerName: 'provider-a' }]));

    expect(router.route('US')).toBe(providerA);
    expect(() => router.route('US')).not.toThrow();
  });
});

// ─── Branch 3: unregistered provider (L63) ───────────────────────────────────

describe('KycRouter RouteTableEntry regression — unregistered provider', () => {
  it('throws the documented error when the mapped provider was never registered', () => {
    const router = buildRouter([{ jurisdiction: 'DE', providerName: 'ghost-provider' }], ['provider-a']);

    expect(() => router.route('DE')).toThrow('Configured provider ghost-provider not registered.');
  });

  it('names the exact missing provider in the error message', () => {
    const router = buildRouter([{ jurisdiction: 'DE', providerName: 'ghost-provider' }], ['provider-a']);

    let thrown: unknown;
    try {
      router.route('DE');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe('Configured provider ghost-provider not registered.');
  });

  it('surfaces provider misconfiguration even though the jurisdiction is mapped (order of checks)', () => {
    // Table maps US → provider-a correctly; but the registered provider has a
    // different name, so the lookup misses. Proves the check is not short-
    // circuited by a successful jurisdiction lookup.
    const router = buildRouter(
      [{ jurisdiction: 'US', providerName: 'provider-a' }],
      ['provider-b'] // wrong provider registered
    );

    expect(() => router.route('US')).toThrow('Configured provider provider-a not registered.');
  });

  it('keeps routing other jurisdictions operational when one mapping is broken (isolation)', () => {
    const providerB = makeProvider('provider-b');
    const router = new KycRouter(SECRET_KEY);
    router.registerProvider(providerB);
    router.loadRouteTable(
      signTable(VERSION, [
        { jurisdiction: 'DE', providerName: 'ghost-provider' },
        { jurisdiction: 'EU', providerName: 'provider-b' },
      ])
    );

    expect(() => router.route('DE')).toThrow('Configured provider ghost-provider not registered.');
    expect(router.route('EU')).toBe(providerB);
  });
});

// ─── Cross-branch integration: full happy path through a routed provider ─────

describe('KycRouter RouteTableEntry regression — end-to-end routing contract', () => {
  it('routes through a registered provider and returns its deterministic result', async () => {
    const providerA = makeProvider('provider-a');
    const router = new KycRouter(SECRET_KEY);
    router.registerProvider(providerA);
    router.loadRouteTable(signTable(VERSION, [{ jurisdiction: 'US', providerName: 'provider-a' }]));

    const routed = router.route('US');
    expect(routed).toBe(providerA);

    const result = await routed.initiateCheck('investor-1', PASSPORT_APPLICANT);
    expect(result.status).toBe('pending');
    expect(result.provider).toBe('provider-a');
    expect(result.referenceId).toBe('ref-provider-a');
    expect(providerA.initiateCheck).toHaveBeenCalledWith('investor-1', PASSPORT_APPLICANT);
  });

  it('remains deterministic across repeated loads of the same table (idempotent reload)', () => {
    const providerA = makeProvider('provider-a');
    const router = new KycRouter(SECRET_KEY);
    router.registerProvider(providerA);

    const table = signTable(VERSION, [
      { jurisdiction: 'US', providerName: 'provider-a' },
      { jurisdiction: 'EU', providerName: 'provider-a' },
    ]);
    router.loadRouteTable(table);
    router.loadRouteTable(table); // reload must not corrupt state

    expect(router.route('US')).toBe(providerA);
    expect(router.route('EU')).toBe(providerA);
    expect(router.getVersion()).toBe(VERSION);
  });

  it('replaces stale mappings on reload (old jurisdiction fails closed afterwards)', () => {
    const providerA = makeProvider('provider-a');
    const providerB = makeProvider('provider-b');
    const router = new KycRouter(SECRET_KEY);
    router.registerProvider(providerA);
    router.registerProvider(providerB);

    router.loadRouteTable(signTable('1', [{ jurisdiction: 'US', providerName: 'provider-a' }]));
    expect(router.route('US')).toBe(providerA);

    router.loadRouteTable(signTable('2', [{ jurisdiction: 'EU', providerName: 'provider-b' }]));
    expect(router.route('EU')).toBe(providerB);
    expect(() => router.route('US')).toThrow('Jurisdiction US not supported. Fails closed.');
    expect(router.getVersion()).toBe('2');
  });
});
