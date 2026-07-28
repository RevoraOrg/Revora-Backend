import { Errors } from '../lib/errors';
import { OfferingHandler } from './offeringHandler';

function makeResponse() {
  const response = {
    json: jest.fn(),
    set: jest.fn(),
  };

  return response as any;
}

describe('OfferingHandler', () => {
  const offeringService = {
    getOfferingStats: jest.fn(),
    getCatalog: jest.fn(),
  } as any;

  let handler: OfferingHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new OfferingHandler(offeringService);
  });

  it('forwards a structured bad-request error when offering id is missing', async () => {
    const next = jest.fn();
    await handler.getStats({ params: {} } as any, makeResponse(), next);

    expect(next).toHaveBeenCalledWith(Errors.badRequest('Offering ID is required'));
  });

  it('returns offering stats for valid requests', async () => {
    const next = jest.fn();
    const res = makeResponse();
    const stats = { offeringId: 'offering-1', totalInvested: '10' };
    offeringService.getOfferingStats.mockResolvedValueOnce(stats);

    await handler.getStats({ params: { id: 'offering-1' } } as any, res, next);

    expect(offeringService.getOfferingStats).toHaveBeenCalledWith('offering-1');
    expect(res.json).toHaveBeenCalledWith(stats);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards service errors from getStats', async () => {
    const next = jest.fn();
    const boom = new Error('boom');
    offeringService.getOfferingStats.mockRejectedValueOnce(boom);

    await handler.getStats({ params: { id: 'offering-1' } } as any, makeResponse(), next);

    expect(next).toHaveBeenCalledWith(boom);
  });

  it('forwards a structured validation error when catalog query parsing fails', async () => {
    const next = jest.fn();
    await handler.getCatalog(
      { query: { limit: '0' } } as any,
      makeResponse(),
      next,
    );

    const forwarded = next.mock.calls[0][0];
    expect(forwarded.code).toBe('VALIDATION_ERROR');
    expect(forwarded.statusCode).toBe(400);
    expect(forwarded.message).toBe('Invalid query parameters');
  });

  it('returns catalog data with cache headers for valid requests', async () => {
    const next = jest.fn();
    const res = makeResponse();
    const catalog = [{ id: 'offering-1' }];
    offeringService.getCatalog.mockResolvedValueOnce(catalog);

    await handler.getCatalog(
      { query: { limit: '5', offset: '2', statuses: 'active,completed' } } as any,
      res,
      next,
    );

    expect(offeringService.getCatalog).toHaveBeenCalledWith(5, 2, ['active', 'completed']);
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=60');
    expect(res.json).toHaveBeenCalledWith({
      data: catalog,
      pagination: { limit: 5, offset: 2, count: 1 },
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards service errors from getCatalog', async () => {
    const next = jest.fn();
    const boom = new Error('catalog failure');
    offeringService.getCatalog.mockRejectedValueOnce(boom);

    await handler.getCatalog({ query: {} } as any, makeResponse(), next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
