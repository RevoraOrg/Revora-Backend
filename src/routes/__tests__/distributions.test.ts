import express from 'express';
import request from 'supertest';
import createDistributionsRouter, { OfferingRepo } from '../distributions';
import { errorHandler } from '../../middleware/errorHandler';
import { DistributionStateManager } from '../../services/distributionScheduler';
import { InMemorySecurityAuditRepository } from '../../security/audit';
import { Errors } from '../../lib/errors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestApp(offeringRepo?: OfferingRepo, userOverrides?: Record<string, string>) {
  const app = express();
  app.use(express.json());

  const verifyJWT: express.RequestHandler = (req, _res, next) => {
    (req as any).user = { id: 'user-1', role: 'admin', ...userOverrides };
    next();
  };

  const distributionEngine = {
    distribute: jest.fn().mockResolvedValue({
      distributionRun: { id: 'run-1' },
      payouts: [],
    }),
  };

  const router = createDistributionsRouter({
    distributionEngine,
    offeringRepo,
    verifyJWT,
  });

  app.use('/api/v1', router);
  app.use(errorHandler);
  return app;
}

function createPauseResumeApp(userOverrides?: Record<string, string>) {
  const app = express();
  app.use(express.json());

  const verifyJWT: express.RequestHandler = (req, _res, next) => {
    (req as any).user = { id: 'user-1', role: 'admin', ...userOverrides };
    next();
  };

  const distributionEngine = {
    distribute: jest.fn().mockResolvedValue({
      distributionRun: { id: 'run-1' },
      payouts: [],
    }),
  };

  const stateManager = new DistributionStateManager();
  const auditRepo = new InMemorySecurityAuditRepository();

  const router = createDistributionsRouter({
    distributionEngine,
    verifyJWT,
    distributionStateManager: stateManager,
    auditRepository: auditRepo,
  });

  app.use('/api/v1', router);
  app.use(errorHandler);
  return { app, stateManager, auditRepo };
}

function makeOfferingRepo(overrides: Record<string, unknown> = {}): OfferingRepo {
  return {
    getById: jest.fn().mockResolvedValue({
      id: 'off-1',
      issuer_id: 'user-1',
      timezone: 'America/New_York',
      ...overrides,
    }),
    update: jest.fn().mockResolvedValue({
      id: 'off-1',
      issuer_id: 'user-1',
      timezone: 'America/New_York',
      ...overrides,
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/offerings/:id/distribute', () => {
  it('triggers a distribution successfully', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/distribute')
      .send({
        revenue_amount: 1000,
        period: {
          start: '2026-06-01T00:00:00Z',
          end: '2026-07-01T00:00:00Z',
        },
      })
      .expect(200);

    expect(res.body.run_id).toBeDefined();
    expect(res.body.total_payouts).toBe(0);
  });

  it('rejects missing revenue amount', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/distribute')
      .send({
        period: {
          start: '2026-06-01T00:00:00Z',
          end: '2026-07-01T00:00:00Z',
        },
      })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid period dates', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/distribute')
      .send({
        revenue_amount: 1000,
        period: { start: 'invalid', end: 'invalid' },
      })
      .expect(400);
  });
});

// ─── Pause / Resume ───────────────────────────────────────────────────────────

describe('POST /api/v1/distributions/:id/pause', () => {
  it('pauses a distribution with valid reason', async () => {
    const { app, stateManager } = createPauseResumeApp();

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Scheduled maintenance window' })
      .expect(200);

    expect(res.body.distribution_id).toBe('dist-1');
    expect(res.body.status).toBe('paused');
    expect(res.body.reason).toBe('Scheduled maintenance window');
    expect(res.body.paused_at).toBeDefined();

    const state = stateManager.getState('dist-1');
    expect(state).toBeDefined();
    expect(state!.state).toBe('paused');
    expect(state!.reason).toBe('Scheduled maintenance window');
  });

  it('rejects pause with empty reason', async () => {
    const { app } = createPauseResumeApp();

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: '' })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects pause with missing reason', async () => {
    const { app } = createPauseResumeApp();

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({})
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects pause with whitespace-only reason', async () => {
    const { app } = createPauseResumeApp();

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: '   ' })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects pause when distribution is already paused', async () => {
    const { app } = createPauseResumeApp();

    await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'First pause' })
      .expect(200);

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Second pause' })
      .expect(409);

    expect(res.body.code).toBe('CONFLICT');
  });

  it('rejects pause for non-admin user', async () => {
    const { app } = createPauseResumeApp({ id: 'user-2', role: 'startup' });

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Maintenance' })
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('records audit event on pause', async () => {
    const { app, auditRepo } = createPauseResumeApp();

    await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Audit test pause' })
      .expect(200);

    const events = auditRepo.getAllEvents();
    const pauseEvent = events.find(e => e.action === 'distribution.pause');
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent!.userId).toBe('user-1');
    expect(pauseEvent!.details).toMatchObject({ reason: 'Audit test pause', distributionId: 'dist-1' });
    expect(pauseEvent!.outcome).toBe('SUCCESS');
  });
});

describe('POST /api/v1/distributions/:id/resume', () => {
  it('resumes a paused distribution', async () => {
    const { app, stateManager } = createPauseResumeApp();

    await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Maintenance' })
      .expect(200);

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/resume')
      .expect(200);

    expect(res.body.distribution_id).toBe('dist-1');
    expect(res.body.status).toBe('resumed');
    expect(res.body.reason).toBe('Maintenance');
    expect(res.body.paused_at).toBeDefined();
    expect(res.body.resumed_at).toBeDefined();

    const state = stateManager.getState('dist-1');
    expect(state).toBeDefined();
    expect(state!.state).toBe('resumed');
    expect(state!.resumedBy).toBe('user-1');
  });

  it('returns idempotent response when resuming unpaused distribution', async () => {
    const { app } = createPauseResumeApp();

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/resume')
      .expect(200);

    expect(res.body.distribution_id).toBe('dist-1');
    expect(res.body.status).toBe('active');
    expect(res.body.message).toContain('not paused');
  });

  it('rejects resume for non-admin user', async () => {
    const { app } = createPauseResumeApp({ id: 'user-2', role: 'startup' });

    const res = await request(app)
      .post('/api/v1/distributions/dist-1/resume')
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('records audit event on resume', async () => {
    const { app, auditRepo } = createPauseResumeApp();

    await request(app)
      .post('/api/v1/distributions/dist-1/pause')
      .send({ reason: 'Resume audit test' })
      .expect(200);

    await request(app)
      .post('/api/v1/distributions/dist-1/resume')
      .expect(200);

    const events = auditRepo.getAllEvents();
    const resumeEvent = events.find(e => e.action === 'distribution.resume');
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent!.userId).toBe('user-1');
    expect(resumeEvent!.details).toMatchObject({ distributionId: 'dist-1' });
    expect(resumeEvent!.outcome).toBe('SUCCESS');
  });
});

// --- Deferred distribution scheduling endpoints ------------------------------

describe('Deferred distribution scheduling endpoints', () => {
  function createScheduleApp(
    userOverrides?: Record<string, string>,
    repoOverrides: Record<string, unknown> = {},
    offeringRepoOverride?: OfferingRepo,
  ) {
    const app = express();
    app.use(express.json());

    const verifyJWT: express.RequestHandler = (req, _res, next) => {
      (req as any).user = { id: 'user-1', role: 'admin', ...userOverrides };
      next();
    };

    const scheduledDistributionRepo = {
      create: jest.fn().mockResolvedValue({
        id: 'sched-1',
        offering_id: 'off-1',
        period_id: 'period-1',
        total_amount: '1000.00',
        run_at: new Date('2026-08-01T00:00:00Z'),
        status: 'scheduled',
        created_by: 'user-1',
      }),
      findByOffering: jest.fn().mockResolvedValue([
        {
          id: 'sched-1',
          offering_id: 'off-1',
          period_id: 'period-1',
          total_amount: '1000.00',
          run_at: new Date('2026-08-01T00:00:00Z'),
          status: 'scheduled',
          attempts: 0,
          error_message: null,
          executed_at: null,
          created_by: 'user-1',
        },
      ]),
      findAll: jest.fn().mockResolvedValue([]),
      markCancelled: jest.fn().mockResolvedValue({
        id: 'sched-1',
        offering_id: 'off-1',
        period_id: 'period-1',
        status: 'cancelled',
      }),
      ...repoOverrides,
    };

    const router = createDistributionsRouter({
      distributionEngine: { distribute: jest.fn(), previewRun: jest.fn() },
      offeringRepo: offeringRepoOverride ?? makeOfferingRepo(),
      verifyJWT,
      scheduledDistributionRepo: scheduledDistributionRepo as any,
    });

    app.use('/api/v1', router);
    app.use(errorHandler);
    return { app, scheduledDistributionRepo };
  }

  it('enqueues a deferred distribution run', async () => {
    const { app, scheduledDistributionRepo } = createScheduleApp();

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'off-1',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: 1000,
        period_start: '2026-06-01T00:00:00Z',
        period_end: '2026-07-01T00:00:00Z',
      })
      .expect(201);

    expect(res.body.id).toBe('sched-1');
    expect(res.body.status).toBe('scheduled');
    expect(scheduledDistributionRepo.create).toHaveBeenCalledWith({
      offering_id: 'off-1',
      period_id: 'period-1',
      period_start: new Date('2026-06-01T00:00:00Z'),
      period_end: new Date('2026-07-01T00:00:00Z'),
      total_amount: 1000,
      run_at: new Date('2026-08-01T00:00:00Z'),
      created_by: 'user-1',
    });
  });

  it('rejects a duplicate enqueue with 409 conflict', async () => {
    const { app } = createScheduleApp({}, {
      create: jest.fn().mockRejectedValue(
        Errors.conflict('A scheduled distribution for this offering and period already exists'),
      ),
    });

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'off-1',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: 1000,
      })
      .expect(409);

    expect(res.body.code).toBe('CONFLICT');
  });

  it('rejects schedule requests from non-admin users', async () => {
    const { app } = createScheduleApp({ role: 'startup' });

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'off-1',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: 1000,
      })
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('rejects missing run_at', async () => {
    const { app } = createScheduleApp();

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({ offering_id: 'off-1', period_id: 'period-1', total_amount: 1000 })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-positive total_amount', async () => {
    const { app } = createScheduleApp();

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'off-1',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: -5,
      })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('rejects an end date that is not after the start date', async () => {
    const { app } = createScheduleApp();

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'off-1',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: 1000,
        period_start: '2026-07-01T00:00:00Z',
        period_end: '2026-06-01T00:00:00Z',
      })
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when the offering does not exist', async () => {
    const { app } = createScheduleApp(
      {},
      {},
      { getById: jest.fn().mockResolvedValue(null) },
    );

    const res = await request(app)
      .post('/api/v1/distributions/schedule')
      .send({
        offering_id: 'missing',
        period_id: 'period-1',
        run_at: '2026-08-01T00:00:00Z',
        total_amount: 1000,
      })
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('lists scheduled distributions with an offering filter', async () => {
    const { app, scheduledDistributionRepo } = createScheduleApp();

    const res = await request(app)
      .get('/api/v1/distributions/schedule?offering_id=off-1')
      .expect(200);

    expect(res.body.scheduled_distributions).toHaveLength(1);
    expect(scheduledDistributionRepo.findByOffering).toHaveBeenCalledWith('off-1');
  });

  it('lists scheduled distributions without a filter', async () => {
    const { app, scheduledDistributionRepo } = createScheduleApp();

    await request(app).get('/api/v1/distributions/schedule').expect(200);

    expect(scheduledDistributionRepo.findAll).toHaveBeenCalled();
  });

  it('forbids non-admins from listing scheduled distributions', async () => {
    const { app } = createScheduleApp({ role: 'startup' });

    const res = await request(app)
      .get('/api/v1/distributions/schedule')
      .expect(403);

    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('cancels a pending scheduled distribution', async () => {
    const { app, scheduledDistributionRepo } = createScheduleApp();

    const res = await request(app)
      .delete('/api/v1/distributions/schedule/sched-1')
      .expect(200);

    expect(res.body.status).toBe('cancelled');
    expect(scheduledDistributionRepo.markCancelled).toHaveBeenCalledWith('sched-1');
  });

  it('returns 404 when cancelling a run that cannot be cancelled', async () => {
    const { app } = createScheduleApp({}, {
      markCancelled: jest.fn().mockResolvedValue(null),
    });

    const res = await request(app)
      .delete('/api/v1/distributions/schedule/sched-1')
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });
});
