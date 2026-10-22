import express from 'express';
import request from 'supertest';
import createDistributionsRouter, {
  OfferingRepo,
  DistributionAccountRepo,
} from './distributions';
import { errorHandler } from '../middleware/errorHandler';
import { AccountingLedgerService } from '../services/accountingLedgerService';

interface TestAppOpts {
  role?: string;
  userId?: string;
  offering?: { id: string; issuer_id: string };
  offeringRepo?: OfferingRepo;
  accountRepo?: DistributionAccountRepo;
  ledger?: AccountingLedgerService;
}

function createApp(opts: TestAppOpts = {}) {
  const {
    role = 'admin',
    userId = 'user-1',
    offering = { id: 'off-1', issuer_id: 'user-1' },
    accountRepo,
    ledger,
  } = opts;

  const app = express();
  app.use(express.json());

  const verifyJWT: express.RequestHandler = (req, _res, next) => {
    (req as any).user = { id: userId, role };
    next();
  };

  const offeringRepo: OfferingRepo = opts.offeringRepo ?? {
    getById: jest.fn().mockResolvedValue(offering),
  };

  const distributionEngine = {
    distribute: jest.fn(),
  };

  const defaultAccountRepo: DistributionAccountRepo = {
    listForAccountingExport: jest.fn().mockResolvedValue([
      {
        id: 'run-1',
        offering_id: 'off-1',
        period_id: 'period-1',
        total_amount: '100.00',
        status: 'completed',
        run_at: new Date('2026-07-01T00:00:00Z'),
        payouts: [
          {
            id: 'p-1',
            investor_id: 'inv-1',
            amount: '100.00',
            status: 'processed',
            created_at: new Date('2026-07-02T00:00:00Z'),
            updated_at: new Date('2026-07-02T00:00:00Z'),
          },
        ],
      },
    ]),
  };

  const router = createDistributionsRouter({
    distributionEngine,
    offeringRepo,
    verifyJWT,
    distributionAccountRepo: accountRepo ?? defaultAccountRepo,
    accountingLedger: ledger ?? new AccountingLedgerService(),
  });

  app.use('/api/v1', router);
  app.use(errorHandler);
  return app;
}

describe('GET /offerings/:id/ledger/export', () => {
  it('returns balanced double-entry JSON for an admin', async () => {
    const app = createApp({ role: 'admin' });
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');

    expect(res.status).toBe(200);
    expect(res.body.totals.balanced).toBe(true);
    expect(res.body.export_id).toBeTruthy();
    expect(res.body.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.lines.length).toBeGreaterThan(0);
  });

  it('returns 401 without an authenticated user', async () => {
    const app = express();
    app.use(express.json());
    const verifyJWT: express.RequestHandler = (_req, _res, next) => next();
    const router = createDistributionsRouter({
      distributionEngine: { distribute: jest.fn() },
      verifyJWT,
    });
    app.use('/api/v1', router);
    app.use(errorHandler);

    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(401);
  });

  it('allows a startup to export their own offering', async () => {
    const app = createApp({ role: 'startup', userId: 'user-1', offering: { id: 'off-1', issuer_id: 'user-1' } });
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(200);
  });

  it('forbids a startup from exporting an offering they do not own', async () => {
    const app = createApp({ role: 'startup', userId: 'user-1', offering: { id: 'off-1', issuer_id: 'other-user' } });
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(403);
  });

  it('forbids non-startup/non-admin roles', async () => {
    const app = createApp({ role: 'investor' });
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the offering is not found for a startup', async () => {
    const offeringRepo: OfferingRepo = {
      getById: jest.fn().mockResolvedValue(null),
    };
    const app = createApp({ role: 'startup', offeringRepo });
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(404);
  });

  it('returns 404 when accounting export is not wired up', async () => {
    const app = express();
    app.use(express.json());
    const verifyJWT: express.RequestHandler = (_req, _res, next) => {
      (_req as any).user = { id: 'user-1', role: 'admin' };
      next();
    };
    app.use('/api/v1', createDistributionsRouter({
      distributionEngine: { distribute: jest.fn() },
      verifyJWT,
    }));
    app.use(errorHandler);
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(404);
  });

  it('returns 400 for an empty period_id', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/offerings/off-1/ledger/export')
      .query({ period_id: '   ' });
    expect(res.status).toBe(400);
  });

  it('passes period_id through to the repository', async () => {
    const accountRepo: DistributionAccountRepo = {
      listForAccountingExport: jest.fn().mockResolvedValue([]),
    };
    const app = createApp({ accountRepo });
    const res = await request(app)
      .get('/api/v1/offerings/off-1/ledger/export')
      .query({ period_id: 'period-2' });
    expect(res.status).toBe(200);
    expect(accountRepo.listForAccountingExport).toHaveBeenCalledWith('off-1', 'period-2');
  });

  it('is idempotent across repeated calls', async () => {
    const app = createApp();
    const res1 = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    const res2 = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res1.body.export_id).toBe(res2.body.export_id);
    expect(res1.body.checksum).toBe(res2.body.checksum);
  });

  it('forbids a startup when no offering repo is available to verify issuer', async () => {
    const app = express();
    app.use(express.json());
    const verifyJWT: express.RequestHandler = (req, _res, next) => {
      (req as any).user = { id: 'user-1', role: 'startup' };
      next();
    };
    const router = createDistributionsRouter({
      distributionEngine: { distribute: jest.fn() },
      offeringRepo: undefined,
      verifyJWT,
      distributionAccountRepo: {
        listForAccountingExport: jest.fn().mockResolvedValue([]),
      },
      accountingLedger: new AccountingLedgerService(),
    });
    app.use('/api/v1', router);
    app.use(errorHandler);
    const res = await request(app).get('/api/v1/offerings/off-1/ledger/export');
    expect(res.status).toBe(403);
  });
});
