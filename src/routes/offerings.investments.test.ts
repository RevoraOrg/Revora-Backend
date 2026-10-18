import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import request from 'supertest';
import {
  createListInvestmentsByOfferingHandler,
  createOfferingInvestmentsRouter,
  Investment,
  InvestmentRepository,
  OfferingRepository,
} from './offerings.investments';

const makeRes = (): jest.Mocked<Response> => {
  const res = {} as unknown as jest.Mocked<Response>;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeNext = (): NextFunction => jest.fn();

/** Loose shape for the auth fields the handler reads off the request. */
type AuthedRequest = Request & { user?: unknown; auth?: unknown };

const asQuery = (query: Record<string, unknown>): Request['query'] =>
  query as unknown as Request['query'];

const setUser = (req: Request, user: unknown): Request => {
  (req as AuthedRequest).user = user;
  return req;
};

const setAuth = (req: Request, auth: unknown): Request => {
  (req as AuthedRequest).auth = auth;
  return req;
};

const makeReq = (
  overrides: Partial<Request> & { user?: { id: unknown; role?: string } } = {}
): Request => {
  const req = {
    params: { id: 'offering-1' },
    query: {},
    ...overrides,
  } as unknown as AuthedRequest;
  if (overrides.user) {
    req.user = overrides.user;
  }
  return req as Request;
};

const investments: Investment[] = [
  {
    id: 'inv-1',
    investor_id: 'investor-1',
    offering_id: 'offering-1',
    amount: '1000.00',
    asset: 'USDC',
    status: 'completed',
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
  },
  {
    id: 'inv-2',
    investor_id: 'investor-2',
    offering_id: 'offering-1',
    amount: '500.00',
    asset: 'USDC',
    status: 'pending',
    created_at: new Date('2024-01-02T00:00:00Z'),
    updated_at: new Date('2024-01-02T00:00:00Z'),
  },
];

describe('GET /api/offerings/:id/investments handler', () => {
  let investmentRepository: jest.Mocked<InvestmentRepository>;
  let offeringRepository: jest.Mocked<OfferingRepository>;

  beforeEach(() => {
    investmentRepository = {
      listByOffering: jest.fn(),
    };
    offeringRepository = {
      getById: jest.fn(),
    };
  });

  const buildHandler = () =>
    createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });

  it('returns 401 when unauthenticated', async () => {
    const handler = buildHandler();
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not an issuer', async () => {
    const handler = buildHandler();
    const req = makeReq({ user: { id: 'issuer-1', role: 'investor' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when offering not found', async () => {
    offeringRepository.getById.mockResolvedValueOnce(null);
    const handler = buildHandler();
    const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Offering not found' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when offering is not owned by the issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-xyz' });
    const handler = buildHandler();
    const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns investments for the offering owned by issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce(investments);
    const handler = buildHandler();
    const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: undefined,
      offset: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ data: investments });
  });

  it('validates and forwards limit and offset', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce([]);
    const handler = buildHandler();
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: asQuery({ limit: '10', offset: '5' }),
    });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 10,
      offset: 5,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 400 when limit is invalid', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    const handler = buildHandler();
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: asQuery({ limit: '-1' }),
    });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 400 when offset is invalid', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    const handler = buildHandler();
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: asQuery({ offset: 'bad' }),
    });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  describe('authentication resolution', () => {
    it('accepts the request when auth.userId is present instead of req.user.id', async () => {
      offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
      investmentRepository.listByOffering.mockResolvedValueOnce([]);
      const handler = buildHandler();
      const req = makeReq({});
      setAuth(req, { userId: 'issuer-1', role: 'issuer' });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: undefined,
        offset: undefined,
      });
    });

    it('returns 401 when req.user.id is not a string', async () => {
      const handler = buildHandler();
      const req = makeReq({});
      setUser(req, { id: 123, role: 'issuer' });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });

    it('returns 401 when auth.userId is not a string', async () => {
      const handler = buildHandler();
      const req = makeReq({});
      setAuth(req, { userId: 123, role: 'issuer' });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('prefers req.user over req.auth when both are present', async () => {
      offeringRepository.getById.mockResolvedValueOnce(null);
      const handler = buildHandler();
      const req = makeReq({});
      setUser(req, { id: 'issuer-1', role: 'issuer' });
      setAuth(req, { userId: 'someone-else', role: 'issuer' });
      const res = makeRes();
      const next = makeNext();

      await handler(req, res, next);

      // Ownership lookup uses the req.user identity (404 because the repo returns null).
      expect(offeringRepository.getById).toHaveBeenCalledWith('offering-1');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('offering ownership resolution', () => {
    it('falls back to issuer_user_id when issuer_id is absent', async () => {
      offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_user_id: 'issuer-1' });
      investmentRepository.listByOffering.mockResolvedValueOnce(investments);
      const handler = buildHandler();
      const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ data: investments });
    });

    it('returns 403 when the offering has no owner field at all', async () => {
      offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1' });
      const handler = buildHandler();
      const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
      expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    });

    it('returns 400 when the offering id param is missing', async () => {
      const handler = buildHandler();
      const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' }, params: {} });
      const res = makeRes();

      await handler(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' });
      expect(offeringRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe('limit/offset boundary values', () => {
    const issuerReq = (query: Record<string, unknown>) =>
      makeReq({ user: { id: 'issuer-1', role: 'issuer' }, query: asQuery(query) });

    beforeEach(() => {
      offeringRepository.getById.mockResolvedValue({ id: 'offering-1', issuer_id: 'issuer-1' });
      investmentRepository.listByOffering.mockResolvedValue([]);
    });

    it('treats missing limit and offset as undefined', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({}), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: undefined,
        offset: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('forwards an explicit zero for limit and offset', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '0', offset: '0' }), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 0,
        offset: 0,
      });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('accepts numeric strings that resolve to integers', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '2.0', offset: ' 3 ' }), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 2,
        offset: 3,
      });
    });

    it('accepts Number.MAX_SAFE_INTEGER', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: String(Number.MAX_SAFE_INTEGER) }), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: Number.MAX_SAFE_INTEGER,
        offset: undefined,
      });
    });

    it('coerces a blank limit to zero rather than rejecting it', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '', offset: '   ' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 0,
        offset: 0,
      });
    });

    it('accepts the numeric notations Number() understands', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '+5', offset: '1e3' }), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 5,
        offset: 1000,
      });
    });

    it('accepts hexadecimal notation', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '0x10' }), res, makeNext());

      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 16,
        offset: undefined,
      });
    });

    it('treats a literal negative zero as valid zero', async () => {
      investmentRepository.listByOffering.mockClear();
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '-0' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const [offeringId, options] = investmentRepository.listByOffering.mock.calls[0];
      expect(offeringId).toBe('offering-1');
      // `-0 < 0` is false, so the value is forwarded unchanged (Object.is keeps the sign).
      expect(Object.is(options?.limit, -0)).toBe(true);
    });

    it('forwards integers above MAX_SAFE_INTEGER with Number precision', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '9007199254740993' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
        limit: 9007199254740992,
        offset: undefined,
      });
    });

    it('returns 400 for a decimal limit', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: '1.5' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
      expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    });

    it('returns 400 for a decimal offset', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ offset: '0.5' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
      expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    });

    it('returns 400 for a non-numeric limit', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: 'abc' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    });

    it('returns 400 for a negative offset', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ offset: '-3' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
    });

    it('returns 400 when limit is repeated (array) in the query string', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: ['1', '2'] }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
      expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    });

    it('returns 400 when offset is repeated (array) in the query string', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ offset: ['0', '1'] }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
      expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
    });

    it('returns 400 when limit is a nested query object', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: { nested: '1' } }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    });

    it('validates limit before offset', async () => {
      const res = makeRes();
      await buildHandler()(issuerReq({ limit: 'bad', offset: 'also-bad' }), res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    });
  });

  describe('repository failure handling', () => {
    it('forwards offering lookup failures to next', async () => {
      const failure = new Error('offering lookup exploded');
      offeringRepository.getById.mockRejectedValueOnce(failure);
      const handler = buildHandler();
      const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
      const res = makeRes();
      const next = makeNext();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('forwards investment listing failures to next', async () => {
      const failure = new Error('investment listing exploded');
      offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
      investmentRepository.listByOffering.mockRejectedValueOnce(failure);
      const handler = buildHandler();
      const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
      const res = makeRes();
      const next = makeNext();

      await handler(req, res, next);

      expect(next).toHaveBeenCalledWith(failure);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });
  });
});

describe('createOfferingInvestmentsRouter', () => {
  let investmentRepository: jest.Mocked<InvestmentRepository>;
  let offeringRepository: jest.Mocked<OfferingRepository>;

  const requireAuth: RequestHandler = (req, res, next) => {
    const userId = req.header('x-user-id');
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    setUser(req, { id: userId, role: req.header('x-role') ?? 'issuer' });
    next();
  };

  const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use(
      createOfferingInvestmentsRouter({
        requireAuth,
        investmentRepository,
        offeringRepository,
      })
    );
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      // Express only registers this as an error handler with all four params declared.
      void _next;
      void err;
      res.status(500).json({ error: 'Internal server error' });
    });
    return app;
  };

  const api = (app: express.Express) => request(app);

  beforeEach(() => {
    investmentRepository = {
      listByOffering: jest.fn(),
    };
    offeringRepository = {
      getById: jest.fn(),
    };
  });

  it('returns 200 with the investments payload for the owning issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce(investments);

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments')
      .set('x-user-id', 'issuer-1')
      .set('x-role', 'issuer');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((row: Investment) => row.id)).toEqual(['inv-1', 'inv-2']);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: undefined,
      offset: undefined,
    });
  });

  it('returns 401 when the auth middleware rejects the request', async () => {
    const res = await api(buildApp()).get('/api/offerings/offering-1/investments');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(offeringRepository.getById).not.toHaveBeenCalled();
  });

  it('returns 403 when the authenticated user is not an issuer', async () => {
    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments')
      .set('x-user-id', 'issuer-1')
      .set('x-role', 'investor');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('returns 404 when the offering does not exist', async () => {
    offeringRepository.getById.mockResolvedValueOnce(null);

    const res = await api(buildApp())
      .get('/api/offerings/missing-offering/investments')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Offering not found' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when the offering belongs to another issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-2' });

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(403);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('forwards valid limit and offset query parameters', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce([investments[0]]);

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments?limit=1&offset=2')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 1,
      offset: 2,
    });
  });

  it('preserves an explicit zero limit and offset', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce([]);

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments?limit=0&offset=0')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(200);
    expect(investmentRepository.listByOffering).toHaveBeenCalledWith('offering-1', {
      limit: 0,
      offset: 0,
    });
  });

  it('returns 400 when limit is repeated in the query string', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments?limit=1&limit=2')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid limit' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 400 when limit is not a non-negative integer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments?limit=-1')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid limit' });
  });

  it('returns 400 when offset is not a non-negative integer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments?offset=1.5')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid offset' });
  });

  it('returns 500 when the repository fails', async () => {
    offeringRepository.getById.mockRejectedValueOnce(new Error('database unavailable'));

    const res = await api(buildApp())
      .get('/api/offerings/offering-1/investments')
      .set('x-user-id', 'issuer-1');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
