import { createDisputeSLAHandlers, createDisputeSLARouter } from '../routes/disputes';
import { DisputeSLAService } from '../services/disputeSLAService';
import { Pool } from 'pg';
import { NotificationRepository } from '../db/repositories/notificationRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Request, Response, NextFunction } from 'express';

// Mock the service
jest.mock('../services/disputeSLAService');
jest.mock('../db/repositories/notificationRepository');
jest.mock('../db/repositories/auditLogRepository');

const MockedSLAService = DisputeSLAService as jest.MockedClass<typeof DisputeSLAService>;

function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as Request;
}

function createMockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

const mockNext: NextFunction = jest.fn();

describe('createDisputeSLAHandlers', () => {
  let service: jest.Mocked<DisputeSLAService>;
  let handlers: ReturnType<typeof createDisputeSLAHandlers>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MockedSLAService({} as any) as jest.Mocked<DisputeSLAService>;
    handlers = createDisputeSLAHandlers(service);
  });

  describe('startSLA', () => {
    it('should start SLA timer and return 201', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { jurisdiction: 'US', state: 'new', assignedUserId: 'user-1' },
      });
      const res = createMockRes();

      service.startTimer.mockResolvedValue({
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'new',
        sla_duration_hours: 4,
        started_at: new Date(),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: 'user-1',
        created_at: new Date(),
        updated_at: new Date(),
      });

      await handlers.startSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ sla: expect.objectContaining({ id: 'sla-1' }) }),
      );
    });

    it('should return 400 when disputeId is missing', async () => {
      const req = createMockReq({
        params: {},
        body: { jurisdiction: 'US', state: 'new' },
      });
      const res = createMockRes();

      await handlers.startSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('disputeId') }),
      );
    });

    it('should return 400 for invalid jurisdiction', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { jurisdiction: 'INVALID', state: 'new' },
      });
      const res = createMockRes();

      await handlers.startSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('jurisdiction') }),
      );
    });

    it('should return 400 for invalid state', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { jurisdiction: 'US', state: 'invalid_state' },
      });
      const res = createMockRes();

      await handlers.startSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('state') }),
      );
    });

    it('should call next on service error', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { jurisdiction: 'US', state: 'new' },
      });
      const res = createMockRes();
      const error = new Error('Service failure');
      service.startTimer.mockRejectedValue(error);

      await handlers.startSLA(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('transitionSLA', () => {
    it('should transition state and return result', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { newState: 'investigating' },
      });
      const res = createMockRes();

      service.transitionState.mockResolvedValue({
        id: 'sla-2',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
        sla_duration_hours: 72,
        started_at: new Date(),
        paused_at: null,
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await handlers.transitionSLA(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ sla: expect.objectContaining({ state: 'investigating' }) }),
      );
    });

    it('should return 400 for invalid newState', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { newState: 'bad_state' },
      });
      const res = createMockRes();

      await handlers.transitionSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should validate newJurisdiction if provided', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { newState: 'triage', newJurisdiction: 'INVALID' },
      });
      const res = createMockRes();

      await handlers.transitionSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should call next on service error', async () => {
      const req = createMockReq({
        params: { disputeId: 'dispute-1' },
        body: { newState: 'investigating' },
      });
      const res = createMockRes();
      const error = new Error('Service failure');
      service.transitionState.mockRejectedValue(error);

      await handlers.transitionSLA(req, res, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('pauseSLA', () => {
    it('should pause timer and return result', async () => {
      const req = createMockReq({ params: { disputeId: 'dispute-1' } });
      const res = createMockRes();

      service.pauseTimer.mockResolvedValue({
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
        sla_duration_hours: 72,
        started_at: new Date(),
        paused_at: new Date(),
        total_paused_ms: 0,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await handlers.pauseSLA(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ sla: expect.objectContaining({ paused_at: expect.any(Date) }) }),
      );
    });

    it('should return 400 when disputeId is missing', async () => {
      const req = createMockReq({ params: {} });
      const res = createMockRes();

      await handlers.pauseSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should call next on service error', async () => {
      const req = createMockReq({ params: { disputeId: 'dispute-1' } });
      const res = createMockRes();
      service.pauseTimer.mockRejectedValue(new Error('Not found'));

      await handlers.pauseSLA(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('resumeSLA', () => {
    it('should resume timer and return result', async () => {
      const req = createMockReq({ params: { disputeId: 'dispute-1' } });
      const res = createMockRes();

      service.resumeTimer.mockResolvedValue({
        id: 'sla-1',
        dispute_id: 'dispute-1',
        jurisdiction: 'US',
        state: 'investigating',
        sla_duration_hours: 72,
        started_at: new Date(),
        paused_at: null,
        total_paused_ms: 5000,
        escalated_at: null,
        escalated: false,
        resolved_at: null,
        assigned_user_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      await handlers.resumeSLA(req, res, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ sla: expect.objectContaining({ paused_at: null }) }),
      );
    });

    it('should return 400 when disputeId is missing', async () => {
      const req = createMockReq({ params: {} });
      const res = createMockRes();

      await handlers.resumeSLA(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('exportBurnReport', () => {
    it('should export CSV with correct headers', async () => {
      const req = createMockReq({
        query: { startDate: '2025-01-01T00:00:00Z', endDate: '2025-01-07T00:00:00Z' },
      });
      const res = createMockRes();

      service.exportBurnReportCSV.mockResolvedValue({
        csv: 'header1,header2\ndata1,data2',
        filename: 'sla-burn-report-2025-01-01.csv',
        rowCount: 1,
      });

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        expect.stringContaining('attachment'),
      );
      expect(res.send).toHaveBeenCalledWith('header1,header2\ndata1,data2');
    });

    it('should return 400 when startDate is missing', async () => {
      const req = createMockReq({ query: { endDate: '2025-01-07T00:00:00Z' } });
      const res = createMockRes();

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when endDate is missing', async () => {
      const req = createMockReq({ query: { startDate: '2025-01-01T00:00:00Z' } });
      const res = createMockRes();

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 when startDate is after endDate', async () => {
      const req = createMockReq({
        query: { startDate: '2025-01-07T00:00:00Z', endDate: '2025-01-01T00:00:00Z' },
      });
      const res = createMockRes();

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('before') }),
      );
    });

    it('should validate jurisdiction filter if provided', async () => {
      const req = createMockReq({
        query: {
          startDate: '2025-01-01T00:00:00Z',
          endDate: '2025-01-07T00:00:00Z',
          jurisdiction: 'INVALID',
        },
      });
      const res = createMockRes();

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should set Cache-Control headers to prevent caching', async () => {
      const req = createMockReq({
        query: { startDate: '2025-01-01T00:00:00Z', endDate: '2025-01-07T00:00:00Z' },
      });
      const res = createMockRes();

      service.exportBurnReportCSV.mockResolvedValue({
        csv: 'data',
        filename: 'test.csv',
        rowCount: 0,
      });

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, no-cache, must-revalidate');
      expect(res.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
    });

    it('should set X-Row-Count header', async () => {
      const req = createMockReq({
        query: { startDate: '2025-01-01T00:00:00Z', endDate: '2025-01-07T00:00:00Z' },
      });
      const res = createMockRes();

      service.exportBurnReportCSV.mockResolvedValue({
        csv: 'data',
        filename: 'test.csv',
        rowCount: 5,
      });

      await handlers.exportBurnReport(req, res, mockNext);

      expect(res.setHeader).toHaveBeenCalledWith('X-Row-Count', '5');
    });

    it('should call next on service error', async () => {
      const req = createMockReq({
        query: { startDate: '2025-01-01T00:00:00Z', endDate: '2025-01-07T00:00:00Z' },
      });
      const res = createMockRes();
      service.exportBurnReportCSV.mockRejectedValue(new Error('DB failure'));

      await handlers.exportBurnReport(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});

describe('createDisputeSLARouter', () => {
  it('should create router with all endpoints', () => {
    const mockDB = {} as Pool;
    const mockNotifRepo = new NotificationRepository(mockDB);
    const mockAuditRepo = new AuditLogRepository(mockDB);
    const mockAuth: any = (req: any, res: any, next: any) => next();

    const router = createDisputeSLARouter({
      db: mockDB,
      notificationRepo: mockNotifRepo,
      auditLogRepo: mockAuditRepo,
      requireAuth: mockAuth,
    });

    expect(router).toBeDefined();
    // Router should have routes registered
    expect(router.stack).toBeDefined();
    expect(router.stack.length).toBeGreaterThanOrEqual(5);
  });
});
