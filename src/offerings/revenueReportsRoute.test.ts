import { NextFunction, Request, Response } from 'express';
import {
  createListRevenueReportsHandler,
  OfferingOwnershipRepository,
  RevenueReport,
  RevenueReportRepository,
} from './revenueReportsRoute';

const mockRevenueReportRepository: jest.Mocked<RevenueReportRepository> = {
  listByOffering: jest.fn(),
};

const mockOfferingOwnershipRepository: jest.Mocked<OfferingOwnershipRepository> = {
  isOwnedByUser: jest.fn(),
};

const createResponse = (): Response => {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createNext = (): NextFunction => jest.fn();

const createRequest = (
  overrides: Partial<Request> & {
    params?: Record<string, string>;
    query?: Record<string, string | undefined>;
    userId?: string;
  }
): Request => {
  const req = {
    params: overrides.params ?? { id: 'offering-1' },
    query: overrides.query ?? {},
    user: overrides.userId ? { id: overrides.userId } : undefined,
  } as unknown as Request;

  return req;
};

const reports: RevenueReport[] = [
  {
    id: 'report-1',
    offering_id: 'offering-1',
    period_id: '2024-01',
    total_revenue: '100.00',
    created_at: new Date('2024-01-31T00:00:00.000Z'),
    updated_at: new Date('2024-01-31T00:00:00.000Z'),
  },
  {
    id: 'report-2',
    offering_id: 'offering-1',
    period_id: '2024-02',
    total_revenue: '120.00',
    created_at: new Date('2024-02-29T00:00:00.000Z'),
    updated_at: new Date('2024-02-29T00:00:00.000Z'),
  },
  {
    id: 'report-3',
    offering_id: 'offering-1',
    period_id: '2024-03',
    total_revenue: '140.00',
    created_at: new Date('2024-03-31T00:00:00.000Z'),
    updated_at: new Date('2024-03-31T00:00:00.000Z'),
  },
];

describe('createListRevenueReportsHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when request is unauthenticated', async () => {
    const handler = createListRevenueReportsHandler({
      revenueReportRepository: mockRevenueReportRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });
    const req = createRequest({ userId: undefined });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockOfferingOwnershipRepository.isOwnedByUser).not.toHaveBeenCalled();
    expect(mockRevenueReportRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns 403 when offering is not owned by authenticated issuer', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(false);

    const handler = createListRevenueReportsHandler({
      revenueReportRepository: mockRevenueReportRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });
    const req = createRequest({ userId: 'issuer-1' });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(mockOfferingOwnershipRepository.isOwnedByUser).toHaveBeenCalledWith(
      'offering-1',
      'issuer-1'
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(mockRevenueReportRepository.listByOffering).not.toHaveBeenCalled();
  });

  it('returns paginated list filtered by optional period range', async () => {
    mockOfferingOwnershipRepository.isOwnedByUser.mockResolvedValueOnce(true);
    mockRevenueReportRepository.listByOffering.mockResolvedValueOnce(reports);

    const handler = createListRevenueReportsHandler({
      revenueReportRepository: mockRevenueReportRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });
    const req = createRequest({
      userId: 'issuer-1',
      query: {
        periodFrom: '2024-02',
        periodTo: '2024-03',
        page: '1',
        pageSize: '1',
      },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      data: [reports[1]],
      pagination: {
        page: 1,
        pageSize: 1,
        total: 2,
        totalPages: 2,
      },
    });
  });

  it('returns 400 for invalid pagination inputs', async () => {
    const handler = createListRevenueReportsHandler({
      revenueReportRepository: mockRevenueReportRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });
    const req = createRequest({
      userId: 'issuer-1',
      query: {
        page: '0',
      },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' });
  });

  it('returns 400 for invalid period range', async () => {
    const handler = createListRevenueReportsHandler({
      revenueReportRepository: mockRevenueReportRepository,
      offeringOwnershipRepository: mockOfferingOwnershipRepository,
    });
    const req = createRequest({
      userId: 'issuer-1',
      query: {
        periodFrom: '2024-05',
        periodTo: '2024-03',
      },
    });
    const res = createResponse();

    await handler(req, res, createNext());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' });
  });
});
