process.env.JWT_SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789';
delete process.env.STELLAR_SERVER_SECRET;
process.env.NODE_ENV = 'test';

let currentTestRole: string | undefined;

jest.mock('../db/pool', () => {
  const mockPool = {
    connect: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(undefined),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
  return {
    pool: mockPool,
    readQuery: jest.fn().mockResolvedValue({ rows: [] }),
    closeAllPools: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../db/client', () => {
  const mockPool = {
    connect: jest.fn().mockResolvedValue({}),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(undefined),
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
  return {
    pool: mockPool,
    query: jest.fn().mockResolvedValue({ rows: [] }),
    closePool: jest.fn().mockResolvedValue(undefined),
    dbHealth: jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 0,
      pool: { totalCount: 0, idleCount: 0, waitingCount: 0, maxConnections: 10 },
    }),
    getClient: jest.fn().mockResolvedValue({}),
  };
});

jest.mock('../middleware/auth', () => {
  const getRole = () => currentTestRole || 'anonymous';

  const setUserIfAuthenticated = (req: any): boolean => {
    const role = getRole();
    if (role === 'anonymous') return false;
    req.user = { id: 'test-user', role, sub: 'test-user' };
    return true;
  };

  return {
    AuthenticatedRequest: Object,
    authMiddleware: () => (req: any, _res: any, next: any) => {
      setUserIfAuthenticated(req);
      next();
    },
    requireAdmin: (req: any, res: any, next: any) => {
      const role = getRole();
      if (role === 'anonymous') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    requireInvestor: (req: any, res: any, next: any) => {
      const role = getRole();
      if (role === 'anonymous') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (role !== 'investor') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    },
    optionalAuthMiddleware: () => (req: any, _res: any, next: any) => {
      setUserIfAuthenticated(req);
      next();
    },
    requireAuth: (req: any, res: any, next: any) => {
      if (!setUserIfAuthenticated(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    },
    createRequireAuth: () => (req: any, res: any, next: any) => {
      if (!setUserIfAuthenticated(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    },
    requireIssuerAuth: (req: any, res: any, next: any) => {
      if (!setUserIfAuthenticated(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      next();
    },
    verifyJwt: jest.fn().mockReturnValue({ sub: 'test-user', role: 'admin' }),
  };
});

jest.mock('../middleware/scimAuth', () => ({
  createScimAuth: () => (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middleware/deviceSignature', () => {
  const actual = jest.requireActual('../middleware/deviceSignature');
  return {
    ...actual,
    createDeviceSignatureMiddleware: () => (_req: any, _res: any, next: any) => {
      (_req as any).deviceAuth = { installId: 'test-install', publicKey: 'test-key' };
      next();
    },
  };
});

import request from 'supertest';
import { createApp } from '../index';
import { enumerateRoutes, RouteEntry } from './routeEnumerator';

const NON_ADMIN_ROLES = ['investor', 'verifier', 'issuer', 'anonymous'];

const ADMIN_ROUTE_PREFIXES = [
  '/api/v1/admin',
  '/api/v1/contract-upgrades',
];

const SKIP_ROUTE_PREFIXES = [
  '/health',
  '/api/v1/overview',
  '/api/v1/startup/register',
];

function isAdminRoute(path: string): boolean {
  return ADMIN_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix));
}

function shouldSkipRoute(path: string): boolean {
  if (path === '/*' || path === '/') return true;
  return SKIP_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix));
}

const OPT_OUT_500_CHECK: Array<{ method: string; pathPrefix: string }> = [
  { method: 'PUT', pathPrefix: '/api/v1/aml/cases/' },
  { method: 'POST', pathPrefix: '/api/v1/aml/alerts/' },
];

function isExcludedFrom500Check(method: string, path: string): boolean {
  return OPT_OUT_500_CHECK.some(
    entry => method === entry.method && path.startsWith(entry.pathPrefix),
  );
}

function resolvePathParams(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/g, 'test-$1');
}

describe('RBAC Negative Authorization Fuzz', () => {
  let app: ReturnType<typeof createApp>;
  let allEndpoints: RouteEntry[];

  beforeAll(() => {
    currentTestRole = 'admin';
    app = createApp();
    allEndpoints = enumerateRoutes(app);
  });

  describe.each(NON_ADMIN_ROLES)('role: %s', (role) => {
    let testRoutes: RouteEntry[];

    beforeAll(() => {
      currentTestRole = role;
      testRoutes = allEndpoints.filter(r => !shouldSkipRoute(r.path));
    });

    it('should deny access to admin routes and never return 500', async () => {
      const failures: Array<{ method: string; path: string; expected: string; actual: number }> = [];

      for (const route of testRoutes) {
        const { path, method } = route;
        const resolvedPath = resolvePathParams(path);
        const lowerMethod = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        const response = await (request(app) as any)[lowerMethod](resolvedPath).send({});

        if (isAdminRoute(path)) {
          if (role === 'anonymous') {
            if (response.status !== 401 && response.status !== 403) {
              failures.push({
                method,
                path,
                expected: '401 or 403',
                actual: response.status,
              });
            }
          } else if (response.status !== 403) {
            failures.push({
              method,
              path,
              expected: '403',
              actual: response.status,
            });
          }
        } else if (response.status === 500 && !isExcludedFrom500Check(method, path)) {
          failures.push({
            method,
            path,
            expected: 'not 500',
            actual: 500,
          });
        }
      }

      if (failures.length > 0) {
        const summary = failures
          .map(f => `${f.method} ${f.path}: expected ${f.expected}, got ${f.actual}`)
          .join('\n  ');
        throw new Error(`Role "${role}" — ${failures.length} failure(s):\n  ${summary}`);
      }
    });
  });
});
