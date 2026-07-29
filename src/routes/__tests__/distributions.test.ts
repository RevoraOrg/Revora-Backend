import express from 'express';
import request from 'supertest';
import createDistributionsRouter, { OfferingRepo } from '../distributions';
import { errorHandler } from '../../middleware/errorHandler';
import { DistributionStateManager } from '../../services/distributionScheduler';
import { InMemorySecurityAuditRepository } from '../../security/audit';

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
