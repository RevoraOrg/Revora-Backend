import crypto from 'crypto';
import {
  AppError,
  ErrorCode,
  ProviderNotRegisteredError,
  UnsupportedJurisdictionError,
} from '../../../lib/errors';
import { KycRouter, type RouteTable, type RouteTableEntry } from '../KycRouter';

const SECRET_KEY = 'typed-kyc-errors-test-secret';

function signedTable(version: string, entries: RouteTableEntry[]): RouteTable {
  const payload = JSON.stringify({ version, entries });
  return {
    version,
    entries,
    signature: crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex'),
  };
}

function routerWithRoutes(entries: RouteTableEntry[]): KycRouter {
  const router = new KycRouter(SECRET_KEY);
  router.loadRouteTable(signedTable('1', entries));
  return router;
}

describe('KycRouter typed route errors', () => {
  it('throws an inspectable UnsupportedJurisdictionError for an unmapped country', () => {
    const router = routerWithRoutes([{ jurisdiction: 'US', providerName: 'registered-provider' }]);

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

  it('throws an inspectable ProviderNotRegisteredError for a missing provider registration', () => {
    const router = routerWithRoutes([{ jurisdiction: 'DE', providerName: 'internal-vendor-prod' }]);

    let thrown: unknown;
    try {
      router.route('DE');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderNotRegisteredError);
    expect(thrown).toBeInstanceOf(AppError);

    const typed = thrown as ProviderNotRegisteredError;
    expect(typed.statusCode).toBe(500);
    expect(typed.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(typed.expose).toBe(false);
    expect(typed.providerName).toBe('internal-vendor-prod');
    expect(typed.message).toContain('internal-vendor-prod');
    expect(typed.publicMessage).toBe('Internal server error');
  });

  it('keeps the two failure classes distinct for instanceof callers', () => {
    const unsupportedRouter = routerWithRoutes([]);
    const missingProviderRouter = routerWithRoutes([
      { jurisdiction: 'CA', providerName: 'ghost-provider' },
    ]);

    expect(() => unsupportedRouter.route('CA')).toThrow(UnsupportedJurisdictionError);
    expect(() => missingProviderRouter.route('CA')).toThrow(ProviderNotRegisteredError);

    try {
      unsupportedRouter.route('CA');
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderNotRegisteredError);
    }
  });
});
