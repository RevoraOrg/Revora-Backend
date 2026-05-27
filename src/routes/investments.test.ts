import crypto from 'crypto';
import { Request, Response } from 'express';
import { Pool, QueryResult } from 'pg';
import { Investment } from '../db/repositories/investmentRepository';
import { createInvestmentsRouter } from './investments';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET =
  'test-secret-key-that-is-at-least-32-characters-long-for-route-tests!';

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
  const headers: Record<string, string> = {};
  let statusCode = 200;
  
  const res = {
    statusCode,
    status: jest.fn().mockImplementation((code: number) => {
      statusCode = code;
      (res as any).statusCode = code;
      return res;
    }),
    json: jest.fn().mockImplementation((data: any) => {
      // Trigger finish event asynchronously
      process.nextTick(() => {
        const finishHandlers = res.once.mock.calls
          .filter(([event]) => event === 'finish')
          .map(([, handler]) => handler);
        finishHandlers.forEach((handler: any) => handler());
      });
      return res;
    }),
    send: jest.fn().mockImplementation((data: any) => {
      // Trigger finish event asynchronously
      process.nextTick(() => {
        const finishHandlers = res.once.mock.calls
          .filter(([event]) => event === 'finish')
          .map(([, handler]) => handler);
        finishHandlers.forEach((handler: any) => handler());
      });
      return res;
    }),
    setHeader: jest.fn().mockImplementation((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
    }),
    getHeader: jest.fn().mockImplementation((name: string) => {
      return headers[name.toLowerCase()];
    }),
    once: jest.fn(),
  } as unknown as jest.Mocked<Response>;
  
  return res;
}

function makeReq(
  authHeader?: string,
  query: Record<string, string> = {},
  method: string = 'GET',
  body?: Record<string, unknown>,
  headers?: Record<string, string>
): Request {
  const allHeaders: Record<string, string> = {
    ...(authHeader ? { authorization: authHeader } : {}),
    ...(headers || {}),
  };
  
  return {
    method,
    url: '/',
    originalUrl: '/',
    headers: allHeaders,
    query,
    body: body || {},
    header: function (name: string) {
      const lowerName = name.toLowerCase();
      // Check both lowercase and original case
      return allHeaders[lowerName] || allHeaders[name];
    },
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
  const method = (req.method || 'GET').toLowerCase();
  const layer = router.stack.find((l: any) => {
    const route = l.route;
    if (!route || !route.methods) return false;
    return Boolean(route.methods[method]);
  });
  if (!layer) {
    throw new Error(`No router layer found for method ${req.method}`);
  }
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
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
    mockPool = { query: jest.fn() };
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it('returns 401 when the Authorization header is absent', () => {
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${badToken}`), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 403 for a token whose role is not investor', () => {
    const token = makeToken({ sub: 'admin-1', role: 'admin' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`), res);

    await flushPromises();

    expect(res.json).toHaveBeenCalledWith({ data: rows });
  });

  it('uses the JWT sub as investor_id when querying', async () => {
    mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

    const token = makeToken({ sub: 'investor-456', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { limit: 'abc' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit parameter' });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative limit', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { limit: '-1' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit parameter' });
  });

  it('returns 400 for a non-numeric offset', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`, { offset: 'bad' }), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset parameter' });
  });

  it('returns 400 for a negative offset', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
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
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    dispatch(router, makeReq(`Bearer ${token}`), res);

    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/investments - Idempotency Protection Tests
// ---------------------------------------------------------------------------

describe('POST /api/investments - Idempotency Protection', () => {
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
    mockPool = { query: jest.fn() };
  });

  afterEach(() => {
    delete process.env['JWT_SECRET'];
  });

  function dispatchPost(
    router: ReturnType<typeof createInvestmentsRouter>,
    req: Request,
    res: Response
  ): void {
    const outerNext = jest.fn();
    const layer = router.stack.find((l: any) => {
      const route = l.route;
      if (!route || !route.methods) return false;
      return Boolean(route.methods['post']);
    });
    if (!layer) {
      throw new Error('No POST router layer found');
    }
    layer.handle(req, res, outerNext);
  }

  it('returns 400 when Idempotency-Key header is missing on POST', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    const req = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' }
    );

    dispatchPost(router, req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Idempotency-Key header is required for investment submissions',
    });
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('returns 400 when Idempotency-Key header is empty', async () => {
    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    const req = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' },
      { 'idempotency-key': '   ' }
    );

    dispatchPost(router, req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Idempotency-Key header is required for investment submissions',
    });
  });

  it('accepts POST request with valid Idempotency-Key', async () => {
    const investmentRow = makeInvestmentRow();
    mockPool.query
      .mockResolvedValueOnce(mockQueryResult([{ id: 'off-1', status: 'active' }])) // offering check
      .mockResolvedValueOnce(mockQueryResult([investmentRow])); // insert

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const res = makeMockRes();
    const req = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' },
      { 'idempotency-key': 'unique-key-123' }
    );

    dispatchPost(router, req, res);
    await flushPromises();

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockPool.query).toHaveBeenCalled();
  });

  it('returns cached response for duplicate Idempotency-Key with same body', async () => {
    const investmentRow = makeInvestmentRow({ id: 'inv-cached' });
    mockPool.query
      .mockResolvedValueOnce(mockQueryResult([{ id: 'off-1', status: 'active' }]))
      .mockResolvedValueOnce(mockQueryResult([investmentRow]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const body = { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' };

    // First request
    const res1 = makeMockRes();
    const req1 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      body,
      { 'idempotency-key': 'replay-key-456' }
    );
    dispatchPost(router, req1, res1);
    await flushPromises();

    expect(res1.status).toHaveBeenCalledWith(201);
    expect(mockPool.query).toHaveBeenCalledTimes(2);

    // Second request with same key and body
    const res2 = makeMockRes();
    const req2 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      body,
      { 'idempotency-key': 'replay-key-456' }
    );
    dispatchPost(router, req2, res2);
    await flushPromises();

    // Should return cached response without hitting DB again
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'cached');
    expect(mockPool.query).toHaveBeenCalledTimes(2); // No additional DB calls
  });

  it('returns 409 conflict when Idempotency-Key is reused with different body', async () => {
    const investmentRow = makeInvestmentRow();
    mockPool.query
      .mockResolvedValueOnce(mockQueryResult([{ id: 'off-1', status: 'active' }]))
      .mockResolvedValueOnce(mockQueryResult([investmentRow]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);

    // First request
    const res1 = makeMockRes();
    const req1 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' },
      { 'idempotency-key': 'conflict-key-789' }
    );
    dispatchPost(router, req1, res1);
    await flushPromises();

    expect(res1.status).toHaveBeenCalledWith(201);

    // Second request with same key but different body
    const res2 = makeMockRes();
    const req2 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '2000.00', asset: 'USDC' }, // Different amount
      { 'idempotency-key': 'conflict-key-789' }
    );
    dispatchPost(router, req2, res2);
    await flushPromises();

    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'conflict');
    expect(res2.json).toHaveBeenCalledWith({
      error: 'Idempotency key reuse with a different request payload is not allowed.',
    });
  });

  it('returns 409 inflight when concurrent requests use same Idempotency-Key', async () => {
    // Mock a slow DB operation
    let resolveQuery: (value: any) => void;
    const queryPromise = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    mockPool.query
      .mockResolvedValueOnce(mockQueryResult([{ id: 'off-1', status: 'active' }]))
      .mockReturnValueOnce(queryPromise);

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);
    const body = { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' };

    // First request (in-flight)
    const res1 = makeMockRes();
    const req1 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      body,
      { 'idempotency-key': 'inflight-key-999' }
    );
    dispatchPost(router, req1, res1);
    await flushPromises();

    // Second concurrent request with same key
    const res2 = makeMockRes();
    const req2 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      body,
      { 'idempotency-key': 'inflight-key-999' }
    );
    dispatchPost(router, req2, res2);
    await flushPromises();

    // Second request should be rejected as inflight
    expect(res2.status).toHaveBeenCalledWith(409);
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'inflight');
    expect(res2.json).toHaveBeenCalledWith({
      error: 'Request with this idempotency key is already in progress.',
    });

    // Complete first request
    resolveQuery!(mockQueryResult([makeInvestmentRow()]));
  });

  it('fingerprints only relevant body fields (offering_id, amount, asset)', async () => {
    const investmentRow = makeInvestmentRow();
    mockPool.query
      .mockResolvedValueOnce(mockQueryResult([{ id: 'off-1', status: 'active' }]))
      .mockResolvedValueOnce(mockQueryResult([investmentRow]));

    const token = makeToken({ sub: 'investor-123', role: 'investor' });
    const router = createInvestmentsRouter(mockPool as unknown as Pool);

    // First request with extra field
    const res1 = makeMockRes();
    const req1 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC', extra: 'ignored' },
      { 'idempotency-key': 'fingerprint-key-111' }
    );
    dispatchPost(router, req1, res1);
    await flushPromises();

    expect(res1.status).toHaveBeenCalledWith(201);

    // Second request without extra field (should have same fingerprint)
    const res2 = makeMockRes();
    const req2 = makeReq(
      `Bearer ${token}`,
      {},
      'POST',
      { offering_id: 'off-1', amount: '1000.00', asset: 'USDC' },
      { 'idempotency-key': 'fingerprint-key-111' }
    );
    dispatchPost(router, req2, res2);
    await flushPromises();

    // Should return cached response (same fingerprint)
    expect(res2.status).toHaveBeenCalledWith(201);
    expect(res2.setHeader).toHaveBeenCalledWith('Idempotency-Status', 'cached');
  });
});
