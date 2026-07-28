import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { createRevenueRoutes } from './revenueRoutes';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { errorHandler } from '../middleware/errorHandler';
import { AppError } from '../lib/errors';

// Mock DB Repositories
jest.mock('../db/repositories/offeringRepository');
jest.mock('../db/repositories/revenueReportRepository');

jest.mock('../middleware/validate', () => ({
  validateParams: () => (req: any, res: any, next: any) => next(),
  validateBody: () => (req: any, res: any, next: any) => next()
}));

// Mock Auth Middleware
jest.mock('../middleware/auth', () => ({
  authMiddleware: () => (req: any, res: any, next: any) => {
    if (req.headers.authorization === 'Bearer valid-token') {
      req.user = { id: 'user-123', role: 'startup' };
      next();
    } else if (req.headers.authorization === 'Bearer other-user') {
      req.user = { id: 'other-456', role: 'startup' };
      next();
    } else if (req.headers.authorization === 'Bearer no-id') {
      req.user = { role: 'startup' };
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }
}));

describe('Revenue Routes', () => {
  let app: express.Application;
  let mockPool: jest.Mocked<Pool>;
  const validOfferingId = '123e4567-e89b-42d3-a456-426614174000';
  
  beforeEach(() => {
    jest.resetAllMocks();
    mockPool = {} as any;
    
    app = express();
    app.use(express.json());
    app.use('/api', createRevenueRoutes(mockPool));
    app.use(errorHandler);
  });

  describe('POST /api/offerings/:id/revenue', () => {
    const validPayload = {
      amount: '1000.50',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-31T23:59:59Z'
    };

    it('should submit a revenue report successfully', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'user-123'
      });
      (RevenueReportRepository.prototype.findOverlappingReport as jest.Mock).mockResolvedValue(null);
      (RevenueReportRepository.prototype.create as jest.Mock).mockResolvedValue({
        id: 'report-1',
        offering_id: validOfferingId,
        amount: '1000.50',
        period_start: new Date(validPayload.periodStart),
        period_end: new Date(validPayload.periodEnd)
      });

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('report-1');
    });

    it('should fail if unauthenticated', async () => {
      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .send(validPayload);

      expect(res.status).toBe(401);
    });

    it('should fail if user has no id in token', async () => {
      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer no-id')
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('should fail with validation error if amount is missing', async () => {
      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          periodStart: validPayload.periodStart,
          periodEnd: validPayload.periodEnd
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should fail if offering not found', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should fail if user does not own offering', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'other-user'
      });

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('should fail if amount is negative or invalid format', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'user-123'
      });

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send({ ...validPayload, amount: '-100' });

      // Might be caught by schema validation or service
      expect(res.status).toBe(400);
    });

    it('should fail if periodEnd <= periodStart', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'user-123'
      });

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send({
          amount: '1000',
          periodStart: '2026-02-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(400); // Bad request / validation error from service
    });

    it('should fail if there is an overlapping report', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'user-123'
      });
      (RevenueReportRepository.prototype.findOverlappingReport as jest.Mock).mockResolvedValue({});

      const res = await request(app)
        .post(`/api/offerings/${validOfferingId}/revenue`)
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);

      expect(res.status).toBe(409); // Conflict error from service
      expect(res.body.code).toBe('CONFLICT');
    });
  });

  describe('POST /api/revenue-reports', () => {
    const validPayload = {
      offeringId: validOfferingId,
      amount: '1000.50',
      periodStart: '2026-01-01T00:00:00Z',
      periodEnd: '2026-01-31T23:59:59Z'
    };

    it('should submit a revenue report successfully', async () => {
      (OfferingRepository.prototype.findById as jest.Mock).mockResolvedValue({
        id: validOfferingId,
        issuer_id: 'user-123'
      });
      (RevenueReportRepository.prototype.findOverlappingReport as jest.Mock).mockResolvedValue(null);
      (RevenueReportRepository.prototype.create as jest.Mock).mockResolvedValue({
        id: 'report-2',
        ...validPayload
      });

      const res = await request(app)
        .post(`/api/revenue-reports`)
        .set('Authorization', 'Bearer valid-token')
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe('report-2');
    });
  });
});
