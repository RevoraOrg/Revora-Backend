import express, { Express, Router } from 'express';
import listEndpoints from 'express-list-endpoints';
import { enumerateRoutes, RouteEntry, ALLOWED_METHODS } from './routeEnumerator';

jest.mock('express-list-endpoints', () => {
  const actual = jest.requireActual('express-list-endpoints');
  const actualFn = actual.default || actual;
  const mockFn = jest.fn((...args: unknown[]) => actualFn(...args));
  return {
    __esModule: true,
    default: mockFn,
  };
});

const mockedListEndpoints = listEndpoints as unknown as jest.Mock;

describe('routeEnumerator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('RouteEntry contract & ALLOWED_METHODS', () => {
    it('defines standard allowed HTTP methods', () => {
      expect(ALLOWED_METHODS).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      expect(Array.isArray(ALLOWED_METHODS)).toBe(true);
    });

    it('produces RouteEntry matching the expected structural interface', () => {
      const app = express();
      app.get('/api/test', (_req, res) => res.send('ok'));

      const routes = enumerateRoutes(app);
      expect(routes).toHaveLength(1);

      const entry: RouteEntry = routes[0];
      expect(typeof entry.path).toBe('string');
      expect(typeof entry.method).toBe('string');
      expect(entry).toEqual({
        path: '/api/test',
        method: 'GET',
      });
    });
  });

  describe('Basic HTTP method extraction and normalization', () => {
    it('enumerates all 5 standard HTTP methods correctly', () => {
      const app = express();
      app.get('/get-endpoint', (_req, res) => res.send('ok'));
      app.post('/post-endpoint', (_req, res) => res.send('ok'));
      app.put('/put-endpoint', (_req, res) => res.send('ok'));
      app.patch('/patch-endpoint', (_req, res) => res.send('ok'));
      app.delete('/delete-endpoint', (_req, res) => res.send('ok'));

      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/get-endpoint', method: 'GET' },
        { path: '/post-endpoint', method: 'POST' },
        { path: '/put-endpoint', method: 'PUT' },
        { path: '/patch-endpoint', method: 'PATCH' },
        { path: '/delete-endpoint', method: 'DELETE' },
      ]);
    });

    it('enumerates multiple HTTP methods registered on the same path via app.route()', () => {
      const app = express();
      app.route('/api/v1/vaults')
        .get((_req, res) => res.send('get'))
        .post((_req, res) => res.send('post'))
        .put((_req, res) => res.send('put'))
        .patch((_req, res) => res.send('patch'))
        .delete((_req, res) => res.send('delete'));

      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/api/v1/vaults', method: 'GET' },
        { path: '/api/v1/vaults', method: 'POST' },
        { path: '/api/v1/vaults', method: 'PUT' },
        { path: '/api/v1/vaults', method: 'PATCH' },
        { path: '/api/v1/vaults', method: 'DELETE' },
      ]);
    });

    it('filters out non-standard / auxiliary HTTP methods such as OPTIONS and HEAD', () => {
      const app = express();
      app.get('/allowed', (_req, res) => res.send('ok'));
      app.options('/options-route', (_req, res) => res.sendStatus(200));
      app.head('/head-route', (_req, res) => res.sendStatus(200));

      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/allowed', method: 'GET' },
      ]);
    });

    it('normalizes lowercase or mixed-case methods to uppercase', () => {
      const app = express();
      app.get('/test', (_req, res) => res.send('ok'));

      const routes = enumerateRoutes(app);
      expect(routes[0].method).toBe('GET');
      expect(routes[0].method).not.toBe('get');
    });
  });

  describe('Routing topologies & path parameters', () => {
    it('handles root path (/) and parameterized routes', () => {
      const app = express();
      app.get('/', (_req, res) => res.send('root'));
      app.get('/users/:userId/milestones/:milestoneId', (_req, res) => res.send('details'));

      const routes = enumerateRoutes(app);

      expect(routes).toContainEqual({ path: '/', method: 'GET' });
      expect(routes).toContainEqual({ path: '/users/:userId/milestones/:milestoneId', method: 'GET' });
    });

    it('handles wildcard and catch-all routes', () => {
      const app = express();
      app.get('/static/*', (_req, res) => res.send('file'));
      app.all('*', (_req, res) => res.send('all'));

      const routes = enumerateRoutes(app);

      expect(routes).toContainEqual({ path: '/static/*', method: 'GET' });
      // app.all registers standard methods
      expect(routes).toContainEqual({ path: '*', method: 'GET' });
      expect(routes).toContainEqual({ path: '*', method: 'POST' });
      expect(routes).toContainEqual({ path: '*', method: 'PUT' });
      expect(routes).toContainEqual({ path: '*', method: 'PATCH' });
      expect(routes).toContainEqual({ path: '*', method: 'DELETE' });
    });

    it('enumerates routes mounted via Router instances', () => {
      const app = express();
      const apiRouter = Router();

      apiRouter.get('/users', (_req, res) => res.send('users'));
      apiRouter.post('/users', (_req, res) => res.send('create user'));

      app.use('/api/v1', apiRouter);

      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/api/v1/users', method: 'GET' },
        { path: '/api/v1/users', method: 'POST' },
      ]);
    });

    it('enumerates deeply nested routers across multiple levels', () => {
      const app = express();
      const v1Router = Router();
      const adminRouter = Router();
      const auditRouter = Router();

      auditRouter.get('/chain/verify', (_req, res) => res.send('verified'));
      auditRouter.post('/witness/publish', (_req, res) => res.send('published'));

      adminRouter.use('/audit', auditRouter);
      v1Router.use('/admin', adminRouter);
      app.use('/api/v1', v1Router);

      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/api/v1/admin/audit/chain/verify', method: 'GET' },
        { path: '/api/v1/admin/audit/witness/publish', method: 'POST' },
      ]);
    });

    it('does not create phantom routes for middleware-only mounts', () => {
      const app = express();
      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));
      app.use((_req, _res, next) => next());

      const routes = enumerateRoutes(app);
      expect(routes).toEqual([]);
    });
  });

  describe('State transitions & determinism', () => {
    it('returns an empty array when an app has no registered routes', () => {
      const app = express();
      const routes = enumerateRoutes(app);
      expect(routes).toEqual([]);
      expect(Array.isArray(routes)).toBe(true);
    });

    it('tracks incremental route additions as state transitions', () => {
      const app = express();

      // State 0: Initial empty app
      expect(enumerateRoutes(app)).toEqual([]);

      // State 1: Add first route
      app.get('/health', (_req, res) => res.send('healthy'));
      expect(enumerateRoutes(app)).toEqual([{ path: '/health', method: 'GET' }]);

      // State 2: Add second route
      app.post('/auth/login', (_req, res) => res.send('token'));
      expect(enumerateRoutes(app)).toEqual([
        { path: '/health', method: 'GET' },
        { path: '/auth/login', method: 'POST' },
      ]);

      // State 3: Mount router with multiple routes
      const subRouter = Router();
      subRouter.get('/items', (_req, res) => res.send('items'));
      subRouter.delete('/items/:id', (_req, res) => res.send('deleted'));
      app.use('/api', subRouter);

      expect(enumerateRoutes(app)).toEqual([
        { path: '/health', method: 'GET' },
        { path: '/auth/login', method: 'POST' },
        { path: '/api/items', method: 'GET' },
        { path: '/api/items/:id', method: 'DELETE' },
      ]);
    });

    it('produces deterministic output across repeated invocations without side-effects', () => {
      const app = express();
      app.get('/api/resource-a', (_req, res) => res.send('a'));
      app.post('/api/resource-b', (_req, res) => res.send('b'));

      const firstCall = enumerateRoutes(app);
      const secondCall = enumerateRoutes(app);
      const thirdCall = enumerateRoutes(app);

      expect(firstCall).toEqual(secondCall);
      expect(secondCall).toEqual(thirdCall);
      expect(firstCall).not.toBe(secondCall); // Fresh array returned
    });
  });

  describe('Invalid inputs & boundary error handling', () => {
    it('throws TypeError when app is null', () => {
      expect(() => enumerateRoutes(null as unknown as Express)).toThrow(TypeError);
      expect(() => enumerateRoutes(null as unknown as Express)).toThrow(/Expected an Express application/);
    });

    it('throws TypeError when app is undefined', () => {
      expect(() => enumerateRoutes(undefined as unknown as Express)).toThrow(TypeError);
      expect(() => enumerateRoutes(undefined as unknown as Express)).toThrow(/Expected an Express application/);
    });

    it('throws TypeError when app is a number primitive', () => {
      expect(() => enumerateRoutes(12345 as unknown as Express)).toThrow(TypeError);
    });

    it('throws TypeError when app is a string primitive', () => {
      expect(() => enumerateRoutes('invalid-app' as unknown as Express)).toThrow(TypeError);
    });

    it('throws TypeError when app is a boolean primitive', () => {
      expect(() => enumerateRoutes(true as unknown as Express)).toThrow(TypeError);
    });

    it('handles empty plain objects gracefully without throwing', () => {
      expect(enumerateRoutes({} as unknown as Express)).toEqual([]);
    });

    it('handles cases where listEndpoints throws an exception gracefully', () => {
      mockedListEndpoints.mockImplementationOnce(() => {
        throw new Error('Internal router parse failure');
      });

      const app = express();
      expect(enumerateRoutes(app)).toEqual([]);
    });

    it('handles cases where listEndpoints returns non-array results gracefully', () => {
      mockedListEndpoints.mockReturnValueOnce(null as unknown as []);

      const app = express();
      expect(enumerateRoutes(app)).toEqual([]);
    });

    it('filters out malformed endpoint objects and invalid method types defensively', () => {
      mockedListEndpoints.mockReturnValueOnce([
        null,
        undefined,
        { path: 12345 as unknown as string, methods: ['GET'] },
        { path: '/no-methods', methods: null as unknown as string[] },
        { path: '/non-array-methods', methods: 'GET' as unknown as string[] },
        {
          path: '/mixed-valid-invalid',
          methods: [123 as unknown as string, null as unknown as string, 'GET', 'INVALID_METHOD', 'post'],
        },
      ]);

      const app = express();
      const routes = enumerateRoutes(app);

      expect(routes).toEqual([
        { path: '/mixed-valid-invalid', method: 'GET' },
        { path: '/mixed-valid-invalid', method: 'POST' },
      ]);
    });
  });
});
