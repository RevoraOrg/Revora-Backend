import crypto from 'crypto';
import { Request, Response } from 'express';
import { Pool, QueryResult } from 'pg';
import { Investment } from '../db/repositories/investmentRepository';
import { createInvestmentsRouter } from './investments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-secret';

/** Build a valid HS256 JWT without any external dependency. */
function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' })
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function makeMockRes(): jest.Mocked<Response> {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Response>;
  return res;
}

function makeReq(
  authHeader?: string,
  query: Record<string, string> = {}
): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    query,
  } as unknown as Request;
}

/**
 * Wait for all pending Promise microtasks to drain.
 *
 * process.nextTick resolves BEFORE Promise callbacks, so two async hops
 * (handler → listByInvestor → db.query) would not have settled yet.
 * setImmediate fires in the event-loop "check" phase — after every
 * microtask queue is empty — making it safe for any depth of awaits.
 */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Dispatch a request through all layers of an Express Router.
 * Express wraps router.get(path, mw1, mw2) into a single Route layer whose
 * internal stack contains [mw1, mw2].  Calling layer.handle dispatches the
 * whole chain without needing path matching.
 */
function dispatch(
  router: ReturnType<typeof createInvestmentsRouter>,
  req: Request,
  res: Response
): void {
  const outerNext = jest.fn(); // called only if every middleware passes through
  const layer = router.stack[0];
  layer.handle(req, res, outerNext);
}

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeInvestmentRow(override: Partial<Investment> = {}): Investment {
  return {
    id: 'inv-1',
    investor_id: 'investor-123',
    offering_id: 'offering-abc',
    amount: '5000.00',
    asset: 'USDC',
    status: 'completed',
    created_at: new Date('2024-01-15'),
    updated_at: new Date('2024-01-15'),
    ...override,
  };
}

function mockQueryResult(rows: Investment[]): QueryResult<Investment> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/investments route handler', () => {
  let mockPool: jest.Mocked<Pool>;

  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
    mockPool = { query: jest.fn() } as unknown as jest.Mocked<Pool>;
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it('returns 401 when the Authorization header is absent', () => {
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 401 for a Bearer token with the wrong secret', () => {
    const badToken = (() => {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const b = Buffer.from(JSON.stringify({ sub: 'x', role: 'investor' })).toString('base64url');
      const s = crypto.createHmac('sha256', 'wrong').update(`${h}.${b}`).digest('base64url');
      return `${h}.${b}.${s}`;
    })();
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${badToken}`), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for a token whose role is not investor', () => {
    const token = makeToken({ sub: 'admin-1', role: 'admin' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('returns the investor\'s investments as { data: [...] }', async () => {
    const rows = [makeInvestmentRow(), makeInvestmentRow({ id: 'inv-2', amount: '1000.00' })];
    mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`), res);

    await flushPromises();

    expect(res.json).toHaveBeenCalledWith({ data: rows });
  });

  it('uses the JWT sub as investor_id when querying', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-456', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    dispatch(router, makeReq(`Bearer ${token}`), makeMockRes());

    await flushPromises();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE investor_id = $1'),
      expect.arrayContaining(['investor-456'])
    );
  });

  // -------------------------------------------------------------------------
  // Filters and pagination
  // -------------------------------------------------------------------------

  it('filters by offering_id when provided', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    dispatch(router, makeReq(`Bearer ${token}`, { offering_id: 'offering-abc' }), makeMockRes());

    await flushPromises();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND offering_id = $2'),
      expect.arrayContaining(['investor-123', 'offering-abc'])
    );
  });

  it('applies limit when provided', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    dispatch(router, makeReq(`Bearer ${token}`, { limit: '10' }), makeMockRes());

    await flushPromises();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT'),
      expect.arrayContaining([10])
    );
  });

  it('applies offset when provided', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    dispatch(router, makeReq(`Bearer ${token}`, { offset: '20' }), makeMockRes());

    await flushPromises();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('OFFSET'),
      expect.arrayContaining([20])
    );
  });

  it('passes offering_id, limit, and offset together', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    dispatch(
      router,
      makeReq(`Bearer ${token}`, { offering_id: 'offering-abc', limit: '5', offset: '10' }),
      makeMockRes()
    );

    await flushPromises();

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('AND offering_id = $2'),
      ['investor-123', 'offering-abc', 5, 10]
    );
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it('returns 400 for a non-numeric limit', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { limit: 'abc' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit parameter' });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative limit', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { limit: '-1' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit parameter' });
  });

  it('returns 400 for a non-numeric offset', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { offset: 'bad' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset parameter' });
  });

  it('returns 400 for a negative offset', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { offset: '-5' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset parameter' });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns 500 when the repository throws', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('db connection lost'));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});
