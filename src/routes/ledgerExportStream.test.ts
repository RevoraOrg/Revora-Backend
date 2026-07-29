import express from 'express';
import request from 'supertest';
import { createLedgerRoutes } from './ledgerRoutes';
import { LedgerService } from '../services/ledgerService';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { errorHandler } from '../middleware/errorHandler';
import { AppError } from '../lib/errors';
import Cursor from 'pg-cursor';

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock('../db/pool', () => ({
  pool: {
    connect: jest.fn(() => Promise.resolve(mockClient)),
  },
}));

const mockCursor = {
  read: jest.fn(),
  close: jest.fn(),
};

jest.mock('pg-cursor', () => {
  return jest.fn().mockImplementation(() => mockCursor);
});

describe('Ledger Routes', () => {
  let app: express.Express;
  let ledgerService: any;
  let auditRepo: any;
  let metricsCollector: any;
  let logger: any;
  let mockUser: any;
  let injectCompleteSecurityContext: boolean;
  let currentReq: any;

  beforeEach(() => {
    jest.clearAllMocks();
    injectCompleteSecurityContext = true;
    currentReq = null;

    ledgerService = {
      initiatePeriodClose: jest.fn(),
      confirmPeriodClose: jest.fn(),
      getLockedPeriodMetadata: jest.fn(),
    } as any;
    auditRepo = {
      createAuditLog: jest.fn().mockResolvedValue(undefined),
    } as any;
    metricsCollector = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
      setGauge: jest.fn(),
    } as any;
    logger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    } as any;

    mockUser = { id: 'user-123', email: 'test@example.com' };

    app = express();
    app.use(express.json());
    app.use((req: any, res, next) => {
      currentReq = req;
      if (mockUser) {
        req.user = mockUser;
        if (injectCompleteSecurityContext) {
          req.securityContext = {
            id: mockUser.id,
            user: mockUser,
            requestId: 'req-123',
            ipAddress: '127.0.0.1',
            userAgent: 'test-agent',
          };
        } else {
          // Minimal security context to trigger fallback branches
          req.securityContext = {
            id: mockUser.id,
            user: mockUser,
          };
          delete req.ip;
          req.get = (name: string) => undefined;
        }
      }
      next();
    });

    app.use('/ledger', createLedgerRoutes(ledgerService, auditRepo, metricsCollector, logger));
    app.use(errorHandler);
  });

  describe('GET /ledger/export.jsonl', () => {
    it('should return 401 if user is not authenticated', async () => {
      mockUser = null; // Unauthenticate
      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(res.status).toBe(401);
      expect(res.body.message).toContain('authentication required');
    });

    it('should return 400 if offeringId query parameter is missing or invalid', async () => {
      const res1 = await request(app)
        .get('/ledger/export.jsonl')
        .query({ year: '2024' });

      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: 'invalid-uuid' });

      expect(res2.status).toBe(400);
    });

    it('should return 400 if year format is invalid', async () => {
      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000', year: '24' });

      expect(res.status).toBe(400);
    });

    it('should stream manifest and rows successfully with correct headers and metrics', async () => {
      mockClient.query.mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '105' }] });
        }
        return mockCursor;
      });

      let readCount = 0;
      mockCursor.read.mockImplementation((batchSize, cb) => {
        readCount++;
        if (readCount === 1) {
          // Return 100 rows, including one with string values for dates to cover fallback branches
          const rows = Array.from({ length: 100 }, (_, i) => ({
            id: `row-${i}`,
            offering_id: '550e8400-e29b-41d4-a716-446655440000',
            period_id: '2024-01',
            amount: '100.00',
            issuer_id: 'issuer-1',
            reported_at: i === 0 ? '2024-01-01T00:00:00.000Z' : new Date('2024-01-01'),
            created_at: i === 0 ? '2024-01-02T00:00:00.000Z' : new Date('2024-01-02'),
          }));
          process.nextTick(() => cb(null, rows));
        } else if (readCount === 2) {
          // Return 5 rows
          const rows = Array.from({ length: 5 }, (_, i) => ({
            id: `row-${100 + i}`,
            offering_id: '550e8400-e29b-41d4-a716-446655440000',
            period_id: '2024-01',
            amount: '100.00',
            issuer_id: 'issuer-1',
            reported_at: new Date('2024-01-01'),
            created_at: new Date('2024-01-02'),
          }));
          process.nextTick(() => cb(null, rows));
        } else {
          // End of stream
          process.nextTick(() => cb(null, []));
        }
      });

      mockCursor.close.mockImplementation((cb: any) => {
        process.nextTick(() => cb());
      });

      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000', year: '2024' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-jsonlines');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain('attachment');

      const lines = res.text.trim().split('\n');
      expect(lines.length).toBe(107); // 1 manifest + 105 data rows + 1 keepalive

      // Check manifest
      const manifest = JSON.parse(lines[0]);
      expect(manifest.type).toBe('manifest');
      expect(manifest.estimatedRowCount).toBe(105);

      // Check keepalive comment position (should be after 100 data rows, which is index 101 in lines array)
      expect(lines[101]).toBe('# keepalive');

      // Verify last data row
      const lastRow = JSON.parse(lines[106]);
      expect(lastRow.id).toBe('row-104');

      // Verify metrics called
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'export.stream.rows',
        expect.any(Object),
        1,
        expect.any(String)
      );
      expect(metricsCollector.recordHistogram).toHaveBeenCalledWith(
        'export.stream.duration',
        expect.any(Number),
        expect.any(Object),
        expect.any(String)
      );

      // Verify resource cleanup
      expect(mockCursor.close).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should successfully filter by periodId with matching format (YYYY-MM)', async () => {
      mockClient.query.mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '10' }] });
        }
        return mockCursor;
      });

      mockCursor.read.mockImplementation((batchSize, cb) => {
        process.nextTick(() => cb(null, [])); // empty stream for simplicity
      });

      mockCursor.close.mockImplementation((cb: any) => {
        process.nextTick(() => cb());
      });

      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000', periodId: '2024-01' });

      expect(res.status).toBe(200);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should successfully filter by periodId with non-matching format (e.g. Q1-2024)', async () => {
      mockClient.query.mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '5' }] });
        }
        return mockCursor;
      });

      mockCursor.read.mockImplementation((batchSize, cb) => {
        process.nextTick(() => cb(null, []));
      });

      mockCursor.close.mockImplementation((cb: any) => {
        process.nextTick(() => cb());
      });

      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000', periodId: 'Q1-2024' });

      expect(res.status).toBe(200);
    });

    it('should handle DB query error before setup of pipeline and release client', async () => {
      // Simulate client.query throwing error for COUNT(*) query
      mockClient.query.mockRejectedValueOnce(new Error('Pre-stream database error'));

      const res = await request(app)
        .get('/ledger/export.jsonl')
        .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(res.status).toBe(500);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('should handle cursor read errors gracefully', async () => {
      mockClient.query.mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '105' }] });
        }
        return mockCursor;
      });

      mockCursor.read.mockImplementation((batchSize, cb) => {
        process.nextTick(() => cb(new Error('Cursor read failed')));
      });

      mockCursor.close.mockImplementation((cb: any) => {
        process.nextTick(() => cb());
      });

      try {
        await request(app)
          .get('/ledger/export.jsonl')
          .query({ offeringId: '550e8400-e29b-41d4-a716-446655440000' });
      } catch (err) {
        // Expect connection aborted/socket hang up
      }

      expect(mockCursor.close).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('POST /ledger/close/:offeringId/initiate/:periodId', () => {
    const offeringId = '550e8400-e29b-41d4-a716-446655440000';
    const periodId = '2024-01';

    it('should return 401 if user is not authenticated', async () => {
      mockUser = null;
      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(401);
    });

    it('should return 400 if params are invalid', async () => {
      const res = await request(app)
        .post(`/ledger/close/invalid-uuid/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 201 and initiate close on success', async () => {
      ledgerService.initiatePeriodClose.mockResolvedValueOnce({
        lock_id: 'lock-123',
        status: 'initiated',
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ lock_id: 'lock-123', status: 'initiated' });
      expect(auditRepo.createAuditLog).toHaveBeenCalled();
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'ledger_close_initiated_total',
        { offering_id: offeringId },
        1,
        expect.any(String)
      );
    });

    it('should return 201 and use request fallback attributes when securityContext has no ip/userAgent', async () => {
      injectCompleteSecurityContext = false;
      ledgerService.initiatePeriodClose.mockResolvedValueOnce({
        lock_id: 'lock-123',
        status: 'initiated',
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .set('User-Agent', 'test-ua')
        .send({});

      expect(res.status).toBe(201);
      expect(auditRepo.createAuditLog).toHaveBeenCalled();
    });

    it('should handle AppError from service gracefully', async () => {
      const appErr = new AppError('CONFLICT', 409, 'Period already locked');
      ledgerService.initiatePeriodClose.mockRejectedValueOnce(appErr);

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'ledger_close_initiate_errors_total',
        expect.any(Object),
        1,
        expect.any(String)
      );
    });

    it('should handle standard Error from service gracefully (covers fallback internal_error branch)', async () => {
      ledgerService.initiatePeriodClose.mockImplementationOnce(() => {
        if (currentReq) {
          currentReq.params = undefined; // clear params to hit fallback offeringId branch
        }
        throw new Error('Generic database failure');
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(500);
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'ledger_close_initiate_errors_total',
        expect.objectContaining({ offering_id: 'unknown', error_type: 'internal_error' }),
        1,
        expect.any(String)
      );
    });

    it('should handle non-Error throw gracefully (covers fallback String(error) branch)', async () => {
      ledgerService.initiatePeriodClose.mockRejectedValueOnce('raw string error');

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/initiate/${periodId}`)
        .send({});

      expect(res.status).toBe(500);
    });
  });

  describe('POST /ledger/close/:offeringId/confirm/:periodId', () => {
    const offeringId = '550e8400-e29b-41d4-a716-446655440000';
    const periodId = '2024-01';

    it('should return 401 if user is not authenticated', async () => {
      mockUser = null;
      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .send({});

      expect(res.status).toBe(401);
    });

    it('should return 201 (or 200) and confirm close on success', async () => {
      ledgerService.confirmPeriodClose.mockResolvedValueOnce({
        lock_id: 'lock-123',
        initiated_by: 'user-1',
        confirmed_by: 'user-2',
        entry_count: 10,
        export_hash: 'abc',
        status: 'confirmed',
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('confirmed');
      expect(auditRepo.createAuditLog).toHaveBeenCalled();
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'ledger_close_confirmed_total',
        { offering_id: offeringId },
        1,
        expect.any(String)
      );
      expect(metricsCollector.setGauge).toHaveBeenCalledWith(
        'ledger_export_entry_count',
        10,
        expect.any(Object),
        expect.any(String)
      );
    });

    it('should return 200 and use fallback request attributes when securityContext lacks ip/userAgent', async () => {
      injectCompleteSecurityContext = false;
      ledgerService.confirmPeriodClose.mockResolvedValueOnce({
        lock_id: 'lock-123',
        initiated_by: 'user-1',
        confirmed_by: 'user-2',
        entry_count: 10,
        export_hash: 'abc',
        status: 'confirmed',
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .set('User-Agent', 'test-ua')
        .send({});

      expect(res.status).toBe(200);
      expect(auditRepo.createAuditLog).toHaveBeenCalled();
    });

    it('should handle AppError from confirm service gracefully', async () => {
      const appErr = new AppError('FORBIDDEN', 403, 'Self-confirmation forbidden');
      ledgerService.confirmPeriodClose.mockRejectedValueOnce(appErr);

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should handle standard Error from confirm service gracefully (covers fallback internal_error branch)', async () => {
      ledgerService.confirmPeriodClose.mockImplementationOnce(() => {
        if (currentReq) {
          currentReq.params = undefined; // clear params to hit fallback offeringId branch
        }
        throw new Error('Generic database failure');
      });

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .send({});

      expect(res.status).toBe(500);
      expect(metricsCollector.incrementCounter).toHaveBeenCalledWith(
        'ledger_close_confirm_errors_total',
        expect.objectContaining({ offering_id: 'unknown', error_type: 'internal_error' }),
        1,
        expect.any(String)
      );
    });

    it('should handle non-Error throw from confirm service gracefully (covers fallback String(error) branch)', async () => {
      ledgerService.confirmPeriodClose.mockRejectedValueOnce('raw string error');

      const res = await request(app)
        .post(`/ledger/close/${offeringId}/confirm/${periodId}`)
        .send({});

      expect(res.status).toBe(500);
    });
  });

  describe('GET /ledger/close/:offeringId/status/:periodId', () => {
    const offeringId = '550e8400-e29b-41d4-a716-446655440000';
    const periodId = '2024-01';

    it('should return 200 status with metadata if found', async () => {
      ledgerService.getLockedPeriodMetadata.mockResolvedValueOnce({
        lock_id: 'lock-123',
        export_hash: 'abc',
        export_signature: 'sig',
      });

      const res = await request(app)
        .get(`/ledger/close/${offeringId}/status/${periodId}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('locked');
      expect(res.body.export_hash).toBe('abc');
    });

    it('should return 404 status if metadata is not found', async () => {
      ledgerService.getLockedPeriodMetadata.mockResolvedValueOnce(null);

      const res = await request(app)
        .get(`/ledger/close/${offeringId}/status/${periodId}`);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should handle non-Error throw from status service gracefully (covers fallback String(error) branch)', async () => {
      ledgerService.getLockedPeriodMetadata.mockRejectedValueOnce('raw string status error');

      const res = await request(app)
        .get(`/ledger/close/${offeringId}/status/${periodId}`);

      expect(res.status).toBe(500);
    });
  });
});
