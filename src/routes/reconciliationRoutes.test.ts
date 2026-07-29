import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { createReconciliationRouter, createReconciliationMetricsHandler } from './reconciliationRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { MetricsCollector } from '../lib/metrics';

// Mock dependencies
const mockReconcile = jest.fn();
const mockQuickBalanceCheck = jest.fn();
const mockVerifyDistributionRun = jest.fn();
const mockValidateRevenueReport = jest.fn();

jest.mock('../services/revenueReconciliationService', () => {
  return {
    RevenueReconciliationService: jest.fn().mockImplementation(() => {
      return {
        reconcile: mockReconcile,
        quickBalanceCheck: mockQuickBalanceCheck,
        verifyDistributionRun: mockVerifyDistributionRun,
        validateRevenueReport: mockValidateRevenueReport,
      };
    })
  };
});

describe('Reconciliation Routes', () => {
  let app: express.Application;
  let mockPool: jest.Mocked<Pool>;
  const validOfferingId = '123e4567-e89b-42d3-a456-426614174000';

  const requireAuthAdmin = (req: any, res: any, next: any) => {
    req.user = { id: 'admin-1', role: 'admin' };
    next();
  };

  const requireAuthUser = (req: any, res: any, next: any) => {
    req.user = { id: 'user-1', role: 'startup' };
    next();
  };

  const requireAuthNoId = (req: any, res: any, next: any) => {
    req.user = { role: 'startup' };
    next();
  };

  const mockOfferingRepo = {
    findById: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPool = {} as any;
  });

  const setupApp = (authMiddleware: any) => {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use('/api/reconciliation', createReconciliationRouter({
      db: mockPool,
      offeringRepo: mockOfferingRepo as any,
      requireAuth: authMiddleware
    }));
    expressApp.use(errorHandler);
    return expressApp;
  };

  describe('POST /api/reconciliation/reconcile', () => {
    it('should reconcile for admin successfully', async () => {
      app = setupApp(requireAuthAdmin);
      mockReconcile.mockResolvedValue({ isBalanced: true });

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({
          offeringId: validOfferingId,
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.isBalanced).toBe(true);
    });

    it('should fail if unauthenticated', async () => {
      app = setupApp(requireAuthNoId);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({ offeringId: validOfferingId, periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(401);
    });

    it('should fail if offeringId is missing', async () => {
      app = setupApp(requireAuthAdmin);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({ periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(400);
    });

    it('should fail if dates are missing', async () => {
      app = setupApp(requireAuthAdmin);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({ offeringId: validOfferingId });

      expect(res.status).toBe(400);
    });

    it('should fail if dates are invalid', async () => {
      app = setupApp(requireAuthAdmin);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({ offeringId: validOfferingId, periodStart: 'invalid', periodEnd: '2026-01-31' });

      expect(res.status).toBe(400);
    });

    it('should fail if periodEnd <= periodStart', async () => {
      app = setupApp(requireAuthAdmin);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({ offeringId: validOfferingId, periodStart: '2026-01-31', periodEnd: '2026-01-01' });

      expect(res.status).toBe(400);
    });

    it('should reconcile for offering owner successfully', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue({ id: validOfferingId, issuer_id: 'user-1' });
      mockReconcile.mockResolvedValue({ isBalanced: true });

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({
          offeringId: validOfferingId,
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(200);
    });

    it('should forbid non-owner startup', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue({ id: validOfferingId, issuer_id: 'other-user' });

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({
          offeringId: validOfferingId,
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(403);
    });

    it('should fail if offering not found', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/reconciliation/reconcile')
        .send({
          offeringId: validOfferingId,
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/reconciliation/balance-check/:offeringId', () => {
    it('should perform balance check', async () => {
      app = setupApp(requireAuthAdmin);
      mockQuickBalanceCheck.mockResolvedValue({ isBalanced: true, difference: '0' });

      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-01-31T23:59:59Z`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should validate missing query params', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}`);

      expect(res.status).toBe(400); // Validation error
    });

    it('should fail if unauthenticated', async () => {
      app = setupApp(requireAuthNoId);
      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-01-31T23:59:59Z`);

      expect(res.status).toBe(401);
    });

    it('should fail if invalid date', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}?periodStart=invalid&periodEnd=2026-01-31T23:59:59Z`);

      expect(res.status).toBe(400);
    });

    it('should fail if non-owner user and offering not found', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue(null);
      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-01-31T23:59:59Z`);

      expect(res.status).toBe(404);
    });

    it('should fail if non-owner user and not issuer', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue({ id: validOfferingId, issuer_id: 'other-user' });
      const res = await request(app)
        .get(`/api/reconciliation/balance-check/${validOfferingId}?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-01-31T23:59:59Z`);

      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/reconciliation/verify-distribution/:runId', () => {
    it('should verify distribution for admin', async () => {
      app = setupApp(requireAuthAdmin);
      mockVerifyDistributionRun.mockResolvedValue({ isValid: true, errors: [] });

      const res = await request(app)
        .post('/api/reconciliation/verify-distribution/run-123');

      expect(res.status).toBe(200);
    });

    it('should forbid non-admin', async () => {
      app = setupApp(requireAuthUser);

      const res = await request(app)
        .post('/api/reconciliation/verify-distribution/run-123');

      expect(res.status).toBe(403);
    });

    it('should fail if unauthenticated', async () => {
      app = setupApp(requireAuthNoId);

      const res = await request(app)
        .post('/api/reconciliation/verify-distribution/run-123');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/reconciliation/validate-report', () => {
    it('should validate report', async () => {
      app = setupApp(requireAuthAdmin);
      mockValidateRevenueReport.mockResolvedValue({ isValid: true, errors: [] });

      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({
          offeringId: validOfferingId,
          amount: '1000',
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(200);
    });

    it('should validate invalid payload', async () => {
      app = setupApp(requireAuthAdmin);
      
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({
          offeringId: validOfferingId,
          amount: 'abc', // Invalid amount
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(400);
    });

    it('should fail if unauthenticated', async () => {
      app = setupApp(requireAuthNoId);
      
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({
          offeringId: validOfferingId,
          amount: '1000',
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T23:59:59Z'
        });

      expect(res.status).toBe(401);
    });

    it('should fail if offeringId is missing', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ amount: '1000', periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(400);
    });

    it('should fail if amount is negative', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ offeringId: validOfferingId, amount: '-1000', periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(400);
    });

    it('should fail if missing dates', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ offeringId: validOfferingId, amount: '1000' });

      expect(res.status).toBe(400);
    });

    it('should fail if invalid dates', async () => {
      app = setupApp(requireAuthAdmin);
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ offeringId: validOfferingId, amount: '1000', periodStart: 'invalid', periodEnd: 'invalid' });

      expect(res.status).toBe(400);
    });

    it('should fail if not owner and offering not found', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue(null);
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ offeringId: validOfferingId, amount: '1000', periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(404);
    });

    it('should fail if not owner and not issuer', async () => {
      app = setupApp(requireAuthUser);
      mockOfferingRepo.findById.mockResolvedValue({ id: validOfferingId, issuer_id: 'other-user' });
      const res = await request(app)
        .post('/api/reconciliation/validate-report')
        .send({ offeringId: validOfferingId, amount: '1000', periodStart: '2026-01-01', periodEnd: '2026-01-31' });

      expect(res.status).toBe(403);
    });
  });
});

// ─── /metrics/reconciliation endpoint ────────────────────────────────────────────

describe('GET /metrics/reconciliation', () => {
  let app: express.Application;
  let metrics: MetricsCollector;

  /** Simulated createMetricsAuthMiddleware that passes through (test env). */
  function allowAllAuth(_req: any, _res: any, next: any): void {
    next();
  }

  /** Simulated auth middleware that rejects with 401. */
  function denyAuth(_req: any, res: any, _next: any): void {
    res.status(401).json({ error: 'Unauthorized', message: 'Bearer token required' });
  }

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, maxCardinality: 100 });
  });

  afterEach(() => {
    metrics.reset();
  });

  function setupApp(authMiddleware: express.RequestHandler): void {
    const expressApp = express();
    expressApp.get(
      '/metrics/reconciliation',
      authMiddleware,
      createReconciliationMetricsHandler(metrics)
    );
    expressApp.use(errorHandler);
    app = expressApp;
  }

  it('returns 200 with valid auth', async () => {
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.status).toBe(200);
  });

  it('returns 401 without valid auth', async () => {
    setupApp(denyAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.status).toBe(401);
  });

  it('returns application/openmetrics-text content type', async () => {
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.headers['content-type']).toContain('application/openmetrics-text');
    expect(res.headers['content-type']).toContain('version=1.0.0');
    expect(res.headers['content-type']).toContain('charset=utf-8');
  });

  it('contains # EOF terminator', async () => {
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toContain('# EOF\n');
  });

  it('includes reconciliation_drift_amount gauge when data exists', async () => {
    metrics.setGauge(
      'reconciliation_drift_amount',
      123.45,
      { offering_id: 'abc' },
      'Monetary drift amount for the offering'
    );
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toContain('reconciliation_drift_amount');
    expect(res.text).toContain('offering_id="abc"');
  });

  it('includes reconciliation_last_run_timestamp when data exists', async () => {
    metrics.setGauge('reconciliation_last_run_timestamp', 1_700_000_000, { offering_id: 'abc' });
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toContain('reconciliation_last_run_timestamp');
  });

  it('includes reconciliation_errors_total counter when data exists', async () => {
    metrics.incrementCounter(
      'reconciliation_errors_total',
      { offering_id: 'abc' },
      3,
      'Cumulative count of failed reconciliation runs'
    );
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toContain('reconciliation_errors_total');
  });

  it('filters out metrics that do not start with reconciliation_', async () => {
    metrics.incrementCounter('http_requests_total', undefined, 1, 'HTTP requests');
    metrics.setGauge('reconciliation_drift_amount', 10, { offering_id: 'abc' });
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toContain('reconciliation_drift_amount');
    expect(res.text).not.toContain('http_requests_total');
  });

  it('returns valid OpenMetrics with _created timestamp lines', async () => {
    metrics.incrementCounter('reconciliation_errors_total', { offering_id: 'abc' }, 1);
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.text).toMatch(/reconciliation_errors_total_created/);
  });

  it('returns 200 with only # EOF when no reconciliation metrics exist', async () => {
    metrics.incrementCounter('other_metric', undefined, 1);
    setupApp(allowAllAuth);
    const res = await request(app).get('/metrics/reconciliation');
    expect(res.status).toBe(200);
    expect(res.text).toBe('# EOF\n');
  });

  it('propagates unexpected errors to error handler', async () => {
    const throwingHandler = createReconciliationMetricsHandler({
      exportOpenMetrics: () => { throw new Error('boom'); },
    } as any);
    const expressApp = express();
    expressApp.get('/metrics/reconciliation', allowAllAuth, throwingHandler);
    expressApp.use(errorHandler);
    app = expressApp;

    const res = await request(app).get('/metrics/reconciliation');
    expect(res.status).toBe(500);
  });
});
