import { NextFunction, Request, Response } from 'express';
import {
  createListDistributionsByOfferingHandler,
  DistributionRepository,
  OfferingOwnershipRepository,
  DistributionRun,
} from './distributionsRoute';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockDistributionRepository: jest.Mocked<DistributionRepository> = {
  listByOffering: jest.fn(),
};

const mockOfferingOwnershipRepository: jest.Mocked<OfferingOwnershipRepository> = {
  isOwnedByUser: jest.fn(),
};

// ─── Test helpers ─────────────────────────────────────────────────────────────

const createResponse = () => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
};

const createNext = (): NextFunction => jest.fn();

const createRequest = (overrides: {
  params?: Record<string, string>;
  query?: Record<string, string | undefined>;
  userId?: string;
}): Request => {
  return {
    params: overrides.params ?? { id: 'offering-1' },
    query: overrides.query ?? {},
    user: overrides.userId ? { id: overrides.userId } : undefined,
  } as unknown as Request;
};

// ─── Fixture data ─────────────────────────────────────────────────────────────

const makeRun = (n: number): DistributionRun => ({
  id: `run-${n}`,
  offering_id: 'offering-1',
  total_amount: String(n * 1000),
  distribution_date: new Date(`2024-0${n}-15T00:00:00.000Z`),
  status: 'completed',
  created_at: new Date(`2024-0${n}-15T00:00:00.000Z`),
  updated_at: new Date(`2024-0${n}-15T00:00:00.000Z`),
});

const runs: DistributionRun[] = [makeRun(3), makeRun(2), makeRun(1)]; // newest-first (repo ordering)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createListDistributionsByOfferingHandler', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // 1. Authentication
  it('returns 401 when request is unauthenticated', async () => {
    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: undefined });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockOfferingOwnershipRepository.isOwnedByUser).not.toHaveBeenCalled();
    expect(mockDistributionRepository.listByOffering).not.toHaveBeenCalled();
  });

  // 2. Offering ownership
  it('returns 403 when offering is not owned by authenticated issuer', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(false);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: 'user-1' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockOfferingOwnershipRepository.isOwnedByUser).toHaveBeenCalledWith(
      'offering-1',
      'user-1'
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockDistributionRepository.listByOffering).not.toHaveBeenCalled();
  });

  // 3. Happy path – default pagination
  it('returns 200 with distributions and pagination metadata on success', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce(runs);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: 'user-1' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockDistributionRepository.listByOffering).toHaveBeenCalledWith('offering-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: runs,
      pagination: {
        page: 1,
        pageSize: 20,
        total: 3,
        totalPages: 1,
      },
    });
  });

  // 4. Pagination – page 1, pageSize 2
  it('paginates correctly: page 1, pageSize 2', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce(runs);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { page: '1', pageSize: '2' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: [makeRun(3), makeRun(2)],
      pagination: { page: 1, pageSize: 2, total: 3, totalPages: 2 },
    });
  });

  // 5. Pagination – page 2, pageSize 2
  it('paginates correctly: page 2, pageSize 2', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce(runs);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { page: '2', pageSize: '2' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: [makeRun(1)],
      pagination: { page: 2, pageSize: 2, total: 3, totalPages: 2 },
    });
  });

  // 6. Pagination – page beyond results returns empty data
  it('returns empty data array when page is beyond total results', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce(runs);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { page: '99', pageSize: '20' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: [],
      pagination: { page: 99, pageSize: 20, total: 3, totalPages: 1 },
    });
  });

  // 7. Empty offering – zero distributions
  it('returns empty data with totalPages 0 when offering has no distributions', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce([]);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: 'user-1' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    });
  });

  // 8. Invalid page param
  it('returns 400 when page query param is invalid', async () => {
    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { page: 'bad' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid pagination parameters' });
    expect(mockDistributionRepository.listByOffering).not.toHaveBeenCalled();
  });

  // 9. Invalid pageSize param
  it('returns 400 when pageSize query param is invalid', async () => {
    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { pageSize: '-5' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid pagination parameters' });
    expect(mockDistributionRepository.listByOffering).not.toHaveBeenCalled();
  });

  // 10. pageSize is capped at MAX_PAGE_SIZE (100)
  it('caps pageSize at 100', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce(runs);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({
      userId: 'user-1',
      query: { pageSize: '999' },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    const call = (res.json as jest.Mock).mock.calls[0][0];
    expect(call.pagination.pageSize).toBe(100);
  });

  // 11. Repository throws – error forwarded to next()
  it('calls next(error) when distributionRepository throws', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    const boom = new Error('db exploded');
    mockDistributionRepository.listByOffering.mockRejectedValueOnce(boom);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: 'user-1' });
    const res = createResponse();
    const next = createNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });

  // 12. Ownership check throws – error forwarded to next()
  it('calls next(error) when ownershipRepository throws', async () => {
    const boom = new Error('ownership check failed');
    mockOfferingOwnershipRepository.isOwnedByUser.mockRejectedValueOnce(boom);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    const req = createRequest({ userId: 'user-1' });
    const res = createResponse();
    const next = createNext();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(mockDistributionRepository.listByOffering).not.toHaveBeenCalled();
  });

  // 13. req.auth fallback (Clerk-style auth)
  it('reads userId from req.auth.userId when req.user is absent', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockDistributionRepository.listByOffering.mockResolvedValueOnce([]);

    const handler = createListDistributionsByOfferingHandler({
      distributionRepository: mockDistributionRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });

    // Build a request that uses req.auth instead of req.user
    const req = {
      params: { id: 'offering-1' },
      query: {},
      user: undefined,
      auth: { userId: 'clerk-user-1' },
    } as unknown as Request;

    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockOfferingOwnershipRepository.isOwnedByUser).toHaveBeenCalledWith(
      'offering-1',
      'clerk-user-1'
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});