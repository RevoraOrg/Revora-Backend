import { NextFunction, Request, Response } from 'express';
import {
  createListInvestmentsByOfferingHandler,
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

const makeReq = (overrides: Partial<Request> & { user?: { id: string; role?: string } } = {}): Request => {
  const req = {
    params: { id: 'offering-1' },
    query: {},
    ...overrides,
  } as unknown as Request;
  if (overrides.user) {
    (req as any).user = overrides.user;
  }
  return req;
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

  it('returns 401 when unauthenticated', async () => {
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when user is not an issuer', async () => {
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({ user: { id: 'issuer-1', role: 'investor' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when offering not found', async () => {
    offeringRepository.getById.mockResolvedValueOnce(null);
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Offering not found' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when offering is not owned by the issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-xyz' });
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({ user: { id: 'issuer-1', role: 'issuer' } });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns investments for the offering owned by issuer', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    investmentRepository.listByOffering.mockResolvedValueOnce(investments);
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
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
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: { limit: '10', offset: '5' } as any,
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
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: { limit: '-1' } as any,
    });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid limit' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 400 when offset is invalid', async () => {
    offeringRepository.getById.mockResolvedValueOnce({ id: 'offering-1', issuer_id: 'issuer-1' });
    const handler = createListInvestmentsByOfferingHandler({
      investmentRepository,
      offeringRepository,
    });
    const req = makeReq({
      user: { id: 'issuer-1', role: 'issuer' },
      query: { offset: 'bad' } as any,
    });
    const res = makeRes();
    await handler(req, res, makeNext());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid offset' });
    expect(investmentRepository.listByOffering).not.toHaveBeenCalled();
  });
});

