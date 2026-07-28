import {
  createMobileSyncHandlers,
  resolveConflicts,
  MobileSyncDeps,
  SqlHoldingRepo,
  SqlDistributionRepo,
} from './mobileSync';
import {
  signCursor,
  verifyCursor,
  validateCursorTimestamp,
  CURSOR_PAGE_SIZE,
} from '../lib/cursor';
import { AppError, Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function mockHoldingRepo(items: any[] = [], total?: number) {
  return {
    listSinceInvestor: jest.fn().mockResolvedValue(items),
    countSinceInvestor: jest.fn().mockResolvedValue(total ?? items.length),
  };
}

function mockDistributionRepo(items: any[] = [], total?: number) {
  return {
    listSinceInvestor: jest.fn().mockResolvedValue(items),
    countSinceInvestor: jest.fn().mockResolvedValue(total ?? items.length),
  };
}

function mockMetrics() {
  const m = new MetricsCollector({ enabled: true, maxCardinality: 1000 });
  jest.spyOn(m, 'incrementCounter');
  return m;
}

function mockPool(queryResult: any[] = [], rowCount = 0) {
  return {
    query: jest.fn().mockResolvedValue({ rows: queryResult, rowCount }),
  } as any;
}

const createMockRequest = (user: any, body: any = {}) => ({
  user,
  body,
  id: 'test-req-id',
} as any);

const createMockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createMockNext = () => jest.fn();

const FIXED_NOW = new Date('2026-07-28T12:00:00.000Z');

// ─── cursor.ts tests ─────────────────────────────────────────────────────────

describe('cursor utilities', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long-for-testing';
  });

  describe('signCursor / verifyCursor round-trip', () => {
    it('round-trips a valid cursor', () => {
      const token = signCursor({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: 0, resources: ['holdings'] });
      const decoded = verifyCursor(token);
      expect(decoded.sub).toBe('u1');
      expect(decoded.ts).toBe('2026-07-28T00:00:00.000Z');
      expect(decoded.page).toBe(0);
      expect(decoded.resources).toEqual(['holdings']);
    });

    it('respects custom TTL', () => {
      const token = signCursor({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: 0, resources: [] }, 60);
      const decoded = verifyCursor(token);
      expect(decoded.sub).toBe('u1');
    });
  });

  describe('verifyCursor validation', () => {
    it('rejects token with missing sub', () => {
      const token = signCursor({ sub: '', ts: '2026-07-28T00:00:00.000Z', page: 0, resources: ['holdings'] });
      expect(() => verifyCursor(token)).toThrow('Cursor missing subject');
    });

    it('rejects token with invalid page (negative)', () => {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET!;
      const token = jwt.sign({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: -1, resources: ['holdings'] }, secret, { algorithm: 'HS256' });
      expect(() => verifyCursor(token)).toThrow('Cursor missing or invalid page index');
    });

    it('rejects token with non-number page', () => {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET!;
      const token = jwt.sign({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: 'abc', resources: ['holdings'] }, secret, { algorithm: 'HS256' });
      expect(() => verifyCursor(token)).toThrow('Cursor missing or invalid page index');
    });

    it('rejects token with missing resources', () => {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET!;
      const token = jwt.sign({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: 0 }, secret, { algorithm: 'HS256' });
      expect(() => verifyCursor(token)).toThrow('Cursor missing resources array');
    });

    it('rejects token with wrong secret', () => {
      const jwt = require('jsonwebtoken');
      const token = jwt.sign({ sub: 'u1', ts: '2026-07-28T00:00:00.000Z', page: 0, resources: [] }, 'wrong-secret-that-is-at-least-32-characters', { algorithm: 'HS256' });
      expect(() => verifyCursor(token)).toThrow();
    });
  });

  describe('validateCursorTimestamp', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(FIXED_NOW);
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('accepts valid past timestamp', () => {
      expect(validateCursorTimestamp('2026-07-27T00:00:00.000Z')).toBe(true);
    });

    it('rejects future timestamp', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      expect(() => validateCursorTimestamp(future)).toThrow('future');
    });

    it('rejects invalid timestamp string', () => {
      expect(() => validateCursorTimestamp('not-a-date')).toThrow('invalid timestamp');
    });
  });
});

// ─── mobileSync routes tests ─────────────────────────────────────────────────

describe('mobileSync routes', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
    metrics = mockMetrics();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('authorization', () => {
    it('returns 401 when user is missing', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(),
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest(null);
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(401);
    });

    it('returns 401 when user.id is missing', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(),
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: undefined, role: 'investor' });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(401);
    });
  });

  describe('initial sync (no cursor)', () => {
    it('returns holdings and distributions from epoch', async () => {
      const holdings = [
        { id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '100', asset: 'USDC', status: 'completed', updated_at: '2026-07-28T10:00:00.000Z', server_version: true },
      ];
      const distributions = [
        { id: 'p1', distribution_id: 'd1', investor_id: 'u1', amount: '50', status: 'processed', updated_at: '2026-07-28T11:00:00.000Z', server_version: true },
      ];

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(holdings),
        distributionRepo: mockDistributionRepo(distributions),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.holdings.items).toHaveLength(1);
      expect(body.holdings.items[0].id).toBe('h1');
      expect(body.holdings.has_more).toBe(false);
      expect(body.distributions.items).toHaveLength(1);
      expect(body.distributions.items[0].id).toBe('p1');
      expect(body.distributions.has_more).toBe(false);
      expect(body.cursor).toBeTruthy();
      expect(body.conflicts).toEqual([]);
      expect(body.server_time).toBe(FIXED_NOW.toISOString());
    });

    it('defaults to all resources when none specified', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, {});
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('holdings');
      expect(body).toHaveProperty('distributions');
    });

    it('filters invalid resource types', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['invalid', 'holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('holdings');
      expect(body).not.toHaveProperty('distributions');
    });

    it('handles empty resources array (no valid resources)', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['bogus'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty('holdings');
      expect(body).not.toHaveProperty('distributions');
    });
  });

  describe('delta sync (with cursor)', () => {
    it('fetches data since cursor timestamp', async () => {
      const cursorTs = '2026-07-27T00:00:00.000Z';
      const cursor = signCursor({ sub: 'u1', ts: cursorTs, page: 0, resources: ['holdings'] });

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([
          { id: 'h2', investor_id: 'u1', offering_id: 'off1', amount: '200', asset: 'XLM', status: 'pending', updated_at: '2026-07-27T12:00:00.000Z', server_version: true },
        ]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { cursor, resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith(
        'u1',
        new Date(cursorTs),
        expect.any(Number),
        expect.any(Number),
      );
    });

    it('increments page index from cursor', async () => {
      const cursor = signCursor({ sub: 'u1', ts: '2026-07-27T00:00:00.000Z', page: 2, resources: ['holdings'] });

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { cursor, resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith(
        'u1',
        expect.any(Date),
        expect.any(Number),
        3 * CURSOR_PAGE_SIZE,
      );
    });
  });

  describe('cursor validation', () => {
    it('rejects invalid cursor', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(),
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { cursor: 'garbage-token' });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/Invalid or expired sync cursor/);
    });

    it('rejects cursor for different user', async () => {
      const cursor = signCursor({ sub: 'u2', ts: '2026-07-27T00:00:00.000Z', page: 0, resources: ['holdings'] });

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(),
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { cursor });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(403);
      expect(err.message).toMatch(/does not belong/);
    });

    it('rejects cursor with future timestamp', async () => {
      const futureTs = new Date(Date.now() + 60_000).toISOString();
      const cursor = signCursor({ sub: 'u1', ts: futureTs, page: 0, resources: ['holdings'] });

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(),
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { cursor });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/Invalid or expired sync cursor/);
    });
  });

  describe('pagination', () => {
    it('sets has_more when items exceed page size', async () => {
      const items = Array.from({ length: CURSOR_PAGE_SIZE }, (_, i) => ({
        id: `h${i}`, investor_id: 'u1', offering_id: 'off1', amount: '10', asset: 'USDC',
        status: 'completed', updated_at: '2026-07-28T00:00:00.000Z', server_version: true,
      }));

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo(items, CURSOR_PAGE_SIZE + 1),
        distributionRepo: mockDistributionRepo([], 0),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.holdings.has_more).toBe(true);

      const decoded = verifyCursor(body.cursor);
      expect(decoded.page).toBe(1);
    });

    it('respects custom page_size', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'], page_size: 5 });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith('u1', expect.any(Date), 5, 0);
    });

    it('clamps page_size to max 100', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'], page_size: 500 });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith('u1', expect.any(Date), 100, 0);
    });

    it('clamps page_size to min 1', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'], page_size: 0 });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith('u1', expect.any(Date), 1, 0);
    });

    it('uses default page_size when not provided', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith('u1', expect.any(Date), CURSOR_PAGE_SIZE, 0);
    });

    it('handles NaN page_size gracefully', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'], page_size: 'abc' });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(deps.holdingRepo.listSinceInvestor).toHaveBeenCalledWith('u1', expect.any(Date), CURSOR_PAGE_SIZE, 0);
    });
  });

  describe('metrics', () => {
    it('emits mobile_sync_pages counter', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'mobile_sync_pages',
        expect.objectContaining({ investor_id: 'u1' }),
        1,
        expect.any(String),
      );
    });
  });

  describe('conflict resolution', () => {
    it('returns conflicts when client versions differ', async () => {
      const serverItem = { id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '200', asset: 'USDC', status: 'completed', updated_at: '2026-07-28T10:00:00.000Z', server_version: true };

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([serverItem]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest(
        { id: 'u1', role: 'investor' },
        {
          resources: ['holdings'],
          client_holdings: [{ id: 'h1', amount: '150', status: 'pending' }],
        },
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].resource_type).toBe('holdings');
      expect(body.conflicts[0].resource_id).toBe('h1');
      expect(body.conflicts[0].resolution).toBe('server_wins');
      expect(body.conflicts[0].client_version).toBeDefined();
      expect(body.conflicts[0].server_version).toBeDefined();
      expect(body.conflicts[0].resolved_at).toBeTruthy();
    });

    it('returns no conflicts when client and server match', async () => {
      const serverItem = { id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '200', asset: 'USDC', status: 'completed', updated_at: '2026-07-28T10:00:00.000Z', server_version: true };

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([serverItem]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest(
        { id: 'u1', role: 'investor' },
        {
          resources: ['holdings'],
          client_holdings: [{ ...serverItem }],
        },
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.conflicts).toHaveLength(0);
    });

    it('detects distribution conflicts', async () => {
      const serverItem = { id: 'p1', distribution_id: 'd1', investor_id: 'u1', amount: '50', status: 'processed', updated_at: '2026-07-28T11:00:00.000Z', server_version: true };

      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([serverItem]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest(
        { id: 'u1', role: 'investor' },
        {
          resources: ['distributions'],
          client_distributions: [{ id: 'p1', status: 'pending' }],
        },
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].resource_type).toBe('distributions');
      expect(body.conflicts[0].resolution).toBe('server_wins');
    });
  });

  describe('error handling', () => {
    it('forwards unexpected errors to next()', async () => {
      const repo = mockHoldingRepo();
      repo.listSinceInvestor.mockRejectedValue(new Error('DB connection lost'));

      const deps: MobileSyncDeps = {
        holdingRepo: repo,
        distributionRepo: mockDistributionRepo(),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('DB connection lost');
    });
  });

  describe('resource selection', () => {
    it('returns only holdings when requested', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([{ id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '100', asset: 'USDC', status: 'completed', updated_at: '2026-07-28T10:00:00.000Z', server_version: true }]),
        distributionRepo: mockDistributionRepo([]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['holdings'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('holdings');
      expect(body).not.toHaveProperty('distributions');
    });

    it('returns only distributions when requested', async () => {
      const deps: MobileSyncDeps = {
        holdingRepo: mockHoldingRepo([]),
        distributionRepo: mockDistributionRepo([{ id: 'p1', distribution_id: 'd1', investor_id: 'u1', amount: '50', status: 'processed', updated_at: '2026-07-28T11:00:00.000Z', server_version: true }]),
        metrics,
      };
      const handlers = createMobileSyncHandlers(deps);
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { resources: ['distributions'] });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.syncHandler(req, res, next);

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('distributions');
      expect(body).not.toHaveProperty('holdings');
    });
  });
});

// ─── SqlHoldingRepo / SqlDistributionRepo tests ──────────────────────────────

describe('SqlHoldingRepo', () => {
  it('queries investments since a given timestamp', async () => {
    const mockRow = {
      id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '100',
      asset: 'USDC', status: 'completed', tx_hash: 'tx123',
      updated_at: new Date('2026-07-28T10:00:00.000Z'),
    };
    const pool = mockPool([mockRow]);
    const repo = new SqlHoldingRepo(pool);

    const result = await repo.listSinceInvestor('u1', new Date('2026-07-27T00:00:00.000Z'), 20, 0);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM investments'),
      ['u1', new Date('2026-07-27T00:00:00.000Z'), 20, 0],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('h1');
    expect(result[0].tx_hash).toBe('tx123');
    expect(result[0].server_version).toBe(true);
  });

  it('handles null tx_hash', async () => {
    const mockRow = {
      id: 'h1', investor_id: 'u1', offering_id: 'off1', amount: '100',
      asset: 'USDC', status: 'completed', tx_hash: null,
      updated_at: '2026-07-28T10:00:00.000Z',
    };
    const pool = mockPool([mockRow]);
    const repo = new SqlHoldingRepo(pool);

    const result = await repo.listSinceInvestor('u1', new Date(), 20, 0);
    expect(result[0].tx_hash).toBeUndefined();
  });

  it('counts investments since timestamp', async () => {
    const pool = mockPool([{ cnt: 5 }]);
    const repo = new SqlHoldingRepo(pool);

    const count = await repo.countSinceInvestor('u1', new Date());
    expect(count).toBe(5);
  });

  it('returns 0 when count query returns no rows', async () => {
    const pool = mockPool([]);
    const repo = new SqlHoldingRepo(pool);

    const count = await repo.countSinceInvestor('u1', new Date());
    expect(count).toBe(0);
  });
});

describe('SqlDistributionRepo', () => {
  it('queries distribution payouts since a given timestamp', async () => {
    const mockRow = {
      id: 'p1', distribution_id: 'd1', investor_id: 'u1', amount: '50',
      status: 'processed', tx_hash: 'tx456',
      updated_at: new Date('2026-07-28T11:00:00.000Z'),
    };
    const pool = mockPool([mockRow]);
    const repo = new SqlDistributionRepo(pool);

    const result = await repo.listSinceInvestor('u1', new Date('2026-07-27T00:00:00.000Z'), 20, 0);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM distribution_payouts'),
      ['u1', new Date('2026-07-27T00:00:00.000Z'), 20, 0],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(result[0].tx_hash).toBe('tx456');
    expect(result[0].server_version).toBe(true);
  });

  it('handles null tx_hash', async () => {
    const mockRow = {
      id: 'p1', distribution_id: 'd1', investor_id: 'u1', amount: '50',
      status: 'processed', tx_hash: null,
      updated_at: '2026-07-28T11:00:00.000Z',
    };
    const pool = mockPool([mockRow]);
    const repo = new SqlDistributionRepo(pool);

    const result = await repo.listSinceInvestor('u1', new Date(), 20, 0);
    expect(result[0].tx_hash).toBeUndefined();
  });

  it('counts payouts since timestamp', async () => {
    const pool = mockPool([{ cnt: 3 }]);
    const repo = new SqlDistributionRepo(pool);

    const count = await repo.countSinceInvestor('u1', new Date());
    expect(count).toBe(3);
  });

  it('returns 0 when count query returns no rows', async () => {
    const pool = mockPool([]);
    const repo = new SqlDistributionRepo(pool);

    const count = await repo.countSinceInvestor('u1', new Date());
    expect(count).toBe(0);
  });
});

// ─── resolveConflicts (unit) ─────────────────────────────────────────────────

describe('resolveConflicts (unit)', () => {
  it('returns empty array when client payload is undefined', () => {
    expect(resolveConflicts(undefined, [], 'holdings')).toEqual([]);
  });

  it('returns empty array when client payload is not an object', () => {
    expect(resolveConflicts('invalid' as any, [], 'holdings')).toEqual([]);
  });

  it('returns empty array when no client items match server items', () => {
    const result = resolveConflicts(
      { id: 'no-match', data: 'x' },
      [{ id: 'server-1', data: 'y' }],
      'holdings',
    );
    expect(result).toEqual([]);
  });

  it('skips items without string id', () => {
    const result = resolveConflicts(
      [{ id: 123 }] as any,
      [{ id: '123', data: 'y' }],
      'holdings',
    );
    expect(result).toEqual([]);
  });

  it('handles array client payloads', () => {
    const result = resolveConflicts(
      [{ id: 'h1', amount: '10' }, { id: 'h2', amount: '20' }] as unknown as Record<string, unknown>,
      [
        { id: 'h1', amount: '50' },
        { id: 'h2', amount: '20' },
      ],
      'holdings',
    );
    expect(result).toHaveLength(1);
    expect(result[0].resource_id).toBe('h1');
  });

  it('skips server_version key when comparing', () => {
    const result = resolveConflicts(
      { id: 'h1', amount: '200', server_version: false },
      [{ id: 'h1', amount: '200', server_version: true }],
      'holdings',
    );
    expect(result).toHaveLength(0);
  });
});

// ─── createMobileSyncRouter ──────────────────────────────────────────────────

describe('createMobileSyncRouter', () => {
  it('creates an Express router with POST /sync route', () => {
    const createMobileSyncRouter = require('./mobileSync').default;
    const mockDeps: MobileSyncDeps = {
      holdingRepo: mockHoldingRepo(),
      distributionRepo: mockDistributionRepo(),
      metrics: mockMetrics(),
    };
    const verifyJWT = jest.fn();
    const router = createMobileSyncRouter(mockDeps, verifyJWT);
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });
});
