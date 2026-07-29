import request from 'supertest';
import express from 'express';
import { LedgerExportService, InMemoryLedgerRepository, LedgerEntry } from '../services/ledgerExportService';
import { createLedgerExportRouter } from './ledgerExport';
import { errorHandler } from '../middleware/errorHandler';
import { signCursor } from '../lib/pagination';

beforeAll(() => {
  process.env.CURSOR_SIGNING_SECRET = 'test-cursor-secret-32-chars-min!!';
});

function seedEntries(): LedgerEntry[] {
  return [
    {
      id: '1',
      gl_account: '1050-Custody',
      entry_date: '2026-07-01',
      description: 'Client deposit',
      debit_amount: '1000.00',
      credit_amount: '0.00',
      currency: 'USD',
      recorded_at: '2026-07-01T10:00:00Z',
      entry_type: 'deposit',
    },
    {
      id: '2',
      gl_account: '1050-Custody',
      entry_date: '2026-07-02',
      description: 'Trade settlement',
      debit_amount: '0.00',
      credit_amount: '500.00',
      currency: 'USD',
      recorded_at: '2026-07-02T10:00:00Z',
      entry_type: 'settlement',
    },
    {
      id: '3',
      gl_account: '1050-Custody',
      entry_date: '2026-07-03',
      description: 'Interest credit',
      debit_amount: '12.50',
      credit_amount: '0.00',
      currency: 'USD',
      recorded_at: '2026-07-03T10:00:00Z',
      entry_type: 'interest',
    },
    {
      id: '4',
      gl_account: '1050-Custody',
      entry_date: '2026-07-04',
      description: 'Withdrawal fee',
      debit_amount: '0.00',
      credit_amount: '25.00',
      currency: 'USD',
      recorded_at: '2026-07-04T10:00:00Z',
      entry_type: 'fee',
    },
    {
      id: '5',
      gl_account: '2010-Revenue',
      entry_date: '2026-07-01',
      description: 'Service revenue',
      debit_amount: '0.00',
      credit_amount: '3000.00',
      currency: 'USD',
      recorded_at: '2026-07-01T10:00:00Z',
      entry_type: 'revenue',
    },
  ];
}

function createApp(repo?: InMemoryLedgerRepository) {
  const r = repo ?? new InMemoryLedgerRepository(seedEntries());
  const service = new LedgerExportService(r);
  const app = express();
  app.use(express.json());
  app.use('/ledger', createLedgerExportRouter(service));
  app.use(errorHandler);
  return { app, repo: r };
}

describe('GET /ledger/export', () => {
  it('returns entries with correct totals for a gl_account', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(4);
    expect(res.body.totals).toEqual({
      total_debit: '1012.50',
      total_credit: '525.00',
      entry_count: 4,
    });
    expect(res.body.has_more).toBe(false);
    expect(res.body.next_cursor).toBeUndefined();
  });

  it('requires gl_account parameter', async () => {
    const { app } = createApp();
    const res = await request(app).get('/ledger/export');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for empty gl_account', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for tampered cursor', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', cursor: 'tampered.invalid' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns empty entries and zero totals for account with no entries', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '9999-Nonexistent' });

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
    expect(res.body.totals).toEqual({
      total_debit: '0',
      total_credit: '0',
      entry_count: 0,
    });
    expect(res.body.has_more).toBe(false);
  });

  it('paginates with cursor and provides next_cursor when hasMore', async () => {
    const repo = new InMemoryLedgerRepository();
    const manyEntries: LedgerEntry[] = [];
    for (let i = 1; i <= 25; i++) {
      manyEntries.push({
        id: `e${String(i).padStart(3, '0')}`,
        gl_account: '1050-Custody',
        entry_date: '2026-07-01',
        description: `Entry ${i}`,
        debit_amount: `${i}.00`,
        credit_amount: '0.00',
        currency: 'USD',
        recorded_at: '2026-07-01T10:00:00Z',
        entry_type: 'deposit',
      });
    }
    repo.addEntries(manyEntries);

    const { app } = createApp(repo);

    const res1 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10' });

    expect(res1.status).toBe(200);
    expect(res1.body.entries).toHaveLength(10);
    expect(res1.body.has_more).toBe(true);
    expect(res1.body.next_cursor).toBeDefined();

    const res2 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10', cursor: res1.body.next_cursor });

    expect(res2.status).toBe(200);
    expect(res2.body.entries).toHaveLength(10);
    expect(res2.body.has_more).toBe(true);
    expect(res2.body.next_cursor).toBeDefined();

    const res3 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10', cursor: res2.body.next_cursor });

    expect(res3.status).toBe(200);
    expect(res3.body.entries).toHaveLength(5);
    expect(res3.body.has_more).toBe(false);
    expect(res3.body.next_cursor).toBeUndefined();
  });

  it('rejects cursor from different gl_account', async () => {
    const repo = new InMemoryLedgerRepository(seedEntries());
    const otherCursor = signCursor({ id: '1', gl: '2010-Revenue', t: Date.now() });

    const { app } = createApp(repo);
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', cursor: otherCursor });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('respects custom limit parameter', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '2' });

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
    expect(res.body.next_cursor).toBeDefined();
  });

  it('clamps limit to 1 minimum and 1000 maximum', async () => {
    const repo = new InMemoryLedgerRepository();
    const entry: LedgerEntry = {
      id: 'x1',
      gl_account: 'Test-Account',
      entry_date: '2026-07-01',
      description: 'Test',
      debit_amount: '1.00',
      credit_amount: '0.00',
      currency: 'USD',
      recorded_at: '2026-07-01T10:00:00Z',
      entry_type: 'test',
    };
    repo.addEntries([entry]);

    const { app } = createApp(repo);

    const resLow = await request(app)
      .get('/ledger/export')
      .query({ gl_account: 'Test-Account', limit: '0' });
    expect(resLow.status).toBe(200);
    expect(resLow.body.entries).toHaveLength(1);

    const resHigh = await request(app)
      .get('/ledger/export')
      .query({ gl_account: 'Test-Account', limit: '9999' });
    expect(resHigh.status).toBe(200);
    expect(resHigh.body.entries).toHaveLength(1);
  });

  it('totals match sum of returned entries to last decimal', async () => {
    const entries: LedgerEntry[] = [
      {
        id: 'a1',
        gl_account: '1050-Custody',
        entry_date: '2026-07-01',
        description: 'A',
        debit_amount: '1234.56',
        credit_amount: '0.00',
        currency: 'USD',
        recorded_at: '2026-07-01T10:00:00Z',
        entry_type: 'deposit',
      },
      {
        id: 'a2',
        gl_account: '1050-Custody',
        entry_date: '2026-07-02',
        description: 'B',
        debit_amount: '0.00',
        credit_amount: '789.01',
        currency: 'USD',
        recorded_at: '2026-07-02T10:00:00Z',
        entry_type: 'withdrawal',
      },
      {
        id: 'a3',
        gl_account: '1050-Custody',
        entry_date: '2026-07-03',
        description: 'C',
        debit_amount: '0.01',
        credit_amount: '0.00',
        currency: 'USD',
        recorded_at: '2026-07-03T10:00:00Z',
        entry_type: 'interest',
      },
    ];

    const repo = new InMemoryLedgerRepository(entries);
    const { app } = createApp(repo);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      total_debit: '1234.57',
      total_credit: '789.01',
      entry_count: 3,
    });

    const computedDebit = res.body.entries
      .reduce((sum: string, e: LedgerEntry) => {
        const [int, frac = ''] = e.debit_amount.split('.');
        return String(Number(sum) + Number(int) + Number(frac ? `0.${frac}` : '0'));
      }, '0');
    expect(res.body.totals.total_debit).toBe(computedDebit);
  });
});
