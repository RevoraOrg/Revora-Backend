import express from 'express';
import request from 'supertest';
import createDistributionsRouter, { OfferingRepo } from '../distributions';
import { errorHandler } from '../../middleware/errorHandler';

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

describe('GET /api/v1/offerings/:id/schedules', () => {
  it('returns the schedule config with timezone', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .get('/api/v1/offerings/off-1/schedules')
      .expect(200);

    expect(res.body.offering_id).toBe('off-1');
    expect(res.body.schedule.timezone).toBe('America/New_York');
    expect(Array.isArray(res.body.schedule.allowed_timezones)).toBe(true);
  });

  it('returns 404 when offering not found', async () => {
    const offeringRepo: OfferingRepo = {
      getById: jest.fn().mockResolvedValue(null),
    };
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .get('/api/v1/offerings/off-404/schedules')
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('allows non-admin owner to access schedule', async () => {
    const offeringRepo = makeOfferingRepo({ issuer_id: 'owner-1' });
    const app = createTestApp(offeringRepo, { id: 'owner-1', role: 'startup' });

    const res = await request(app)
      .get('/api/v1/offerings/off-1/schedules')
      .expect(200);

    expect(res.body.offering_id).toBe('off-1');
  });

  it('forbids non-admin non-owner from accessing schedule', async () => {
    const offeringRepo = makeOfferingRepo({ issuer_id: 'owner-1' });
    const app = createTestApp(offeringRepo, { id: 'other-user', role: 'startup' });

    const res = await request(app)
      .get('/api/v1/offerings/off-1/schedules')
      .expect(403);
  });

  it('returns 401 when not authenticated', async () => {
    const app = express();
    app.use(express.json());

    const verifyJWT: express.RequestHandler = (_req, res) => {
      res.status(401).json({ code: 'UNAUTHORIZED' });
    };

    const router = createDistributionsRouter({
      distributionEngine: { distribute: jest.fn() },
      offeringRepo: makeOfferingRepo(),
      verifyJWT,
    });

    app.use('/api/v1', router);

    const res = await request(app)
      .get('/api/v1/offerings/off-1/schedules')
      .expect(401);

    expect(res.body.code).toBe('UNAUTHORIZED');
  });
});

describe('PUT /api/v1/offerings/:id/schedules/timezone', () => {
  it('updates the timezone successfully', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .put('/api/v1/offerings/off-1/schedules/timezone')
      .send({ timezone: 'Europe/Paris' })
      .expect(200);

    expect(res.body.offering_id).toBe('off-1');
    expect(res.body.schedule.timezone).toBe('Europe/Paris');
  });

  it('rejects invalid timezone', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .put('/api/v1/offerings/off-1/schedules/timezone')
      .send({ timezone: 'Bad/Zone' })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty timezone', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .put('/api/v1/offerings/off-1/schedules/timezone')
      .send({})
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 404 when offering not found', async () => {
    const offeringRepo: OfferingRepo = {
      getById: jest.fn().mockResolvedValue(null),
    };
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .put('/api/v1/offerings/off-404/schedules/timezone')
      .send({ timezone: 'Europe/Paris' })
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('forbids non-admin non-owner from updating timezone', async () => {
    const offeringRepo = makeOfferingRepo({ issuer_id: 'owner-1' });
    const app = createTestApp(offeringRepo, { id: 'other-user', role: 'startup' });

    const res = await request(app)
      .put('/api/v1/offerings/off-1/schedules/timezone')
      .send({ timezone: 'Europe/Paris' })
      .expect(403);
  });
});

describe('POST /api/v1/offerings/:id/schedules/preview', () => {
  it('previews a window for a given timezone', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({
        timezone: 'America/New_York',
        period: {
          start: '2026-06-01T00:00:00Z',
          end: '2026-07-01T00:00:00Z',
        },
      })
      .expect(200);

    expect(res.body.offering_id).toBe('off-1');
    expect(res.body.timezone).toBe('America/New_York');
    expect(res.body.window).toBeDefined();
    expect(res.body.window.wall_clock_start).toBeDefined();
  });

  it('previews using offering timezone when not specified', async () => {
    const offeringRepo = makeOfferingRepo({ timezone: 'America/New_York' });
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({
        period: {
          start: '2026-06-01T00:00:00Z',
          end: '2026-07-01T00:00:00Z',
        },
      })
      .expect(200);

    expect(res.body.timezone).toBe('America/New_York');
  });

  it('rejects missing timezone and period', async () => {
    const offeringRepo = makeOfferingRepo({ timezone: undefined });
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({})
      .expect(400);

    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns error when offering not found', async () => {
    const offeringRepo: OfferingRepo = {
      getById: jest.fn().mockResolvedValue(null),
    };
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-404/schedules/preview')
      .send({
        timezone: 'Europe/Paris',
        period: { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' },
      })
      .expect(404);
  });

  it('rejects missing period start/end', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({
        timezone: 'America/New_York',
        period: { start: '2026-06-01T00:00:00Z' },
      })
      .expect(400);
  });

  it('rejects invalid date in period', async () => {
    const offeringRepo = makeOfferingRepo();
    const app = createTestApp(offeringRepo);

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({
        timezone: 'America/New_York',
        period: { start: 'not-a-date', end: '2026-07-01T00:00:00Z' },
      })
      .expect(400);
  });

  it('forbids non-admin non-owner from preview', async () => {
    const offeringRepo = makeOfferingRepo({ issuer_id: 'owner-1' });
    const app = createTestApp(offeringRepo, { id: 'other-user', role: 'startup' });

    const res = await request(app)
      .post('/api/v1/offerings/off-1/schedules/preview')
      .send({
        timezone: 'America/New_York',
        period: { start: '2026-06-01T00:00:00Z', end: '2026-07-01T00:00:00Z' },
      })
      .expect(403);
  });
});

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
