import crypto from 'crypto';
import {
  AppError,
  ErrorCode,
  UnsupportedJurisdictionError,
} from '../../../lib/errors';
import { KycRouter, type RouteTable, type RouteTableEntry } from '../KycRouter';
import type { KycProvider, KycCheckResult } from '../KycProvider';

const SECRET_KEY = 'typed-kyc-errors-test-secret';

function signedTable(version: string, entries: RouteTableEntry[]): RouteTable {
  const payload = JSON.stringify({ version, entries });
  return {
    version,
    entries,
    signature: crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex'),
  };
}

function makeProvider(name: string): KycProvider {
  const result: KycCheckResult = { status: 'pending', provider: name, referenceId: `ref-${name}` };
  return {
    name,
    initiateCheck: jest.fn().mockResolvedValue(result),
    getStatus: jest.fn().mockResolvedValue(result),
    handleWebhook: jest.fn().mockResolvedValue(result),
  };
}

function routerWithRoutes(entries: RouteTableEntry[], providerNames: string[] = []): KycRouter {
  const router = new KycRouter(SECRET_KEY);
  for (const name of providerNames) {
    router.registerProvider(makeProvider(name));
  }
  router.loadRouteTable(signedTable('1', entries));
  return router;
}

describe('KycRouter typed route errors', () => {
  it('throws an inspectable UnsupportedJurisdictionError for an unmapped country', () => {
    const router = routerWithRoutes(
      [{ jurisdiction: 'US', providerName: 'registered-provider' }],
      ['registered-provider'],
    );

    let thrown: unknown;
    try {
      router.route('ZZ');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedJurisdictionError);
    expect(thrown).toBeInstanceOf(AppError);

    const typed = thrown as UnsupportedJurisdictionError;
    expect(typed.statusCode).toBe(403);
    expect(typed.code).toBe(ErrorCode.FORBIDDEN);
    expect(typed.expose).toBe(true);
    expect(typed.jurisdiction).toBe('ZZ');
    expect(typed.message).toBe('Jurisdiction ZZ not supported. Fails closed.');
    expect(typed.publicMessage).toBe('Jurisdiction not supported');
  });

  it('rejects a table that references an unregistered provider before installing it', () => {
    const router = new KycRouter(SECRET_KEY);
    const table = signedTable('1', [{ jurisdiction: 'DE', providerName: 'internal-vendor-prod' }]);

    let thrown: unknown;
    try {
      router.loadRouteTable(table);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('internal-vendor-prod');
    expect((thrown as Error).message).toContain('unregistered provider');

    // Nothing was installed, so the jurisdiction still fails closed.
    expect(router.getVersion()).toBe('');
    expect(() => router.route('DE')).toThrow(UnsupportedJurisdictionError);
  });

  it('keeps unsupported-jurisdiction and unregistered-provider failures distinct', () => {
    const unsupportedRouter = routerWithRoutes([]);
    const misconfigured = new KycRouter(SECRET_KEY);
    const badTable = signedTable('1', [{ jurisdiction: 'CA', providerName: 'ghost-provider' }]);

    expect(() => unsupportedRouter.route('CA')).toThrow(UnsupportedJurisdictionError);
    expect(() => misconfigured.loadRouteTable(badTable)).toThrow(/unregistered provider/);
    expect(() => misconfigured.route('CA')).toThrow(UnsupportedJurisdictionError);
  });
});
