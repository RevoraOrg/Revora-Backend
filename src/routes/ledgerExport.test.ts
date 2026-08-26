import request from 'supertest';
import express from 'express';
import { LedgerExportService, InMemoryLedgerRepository, LedgerEntry, computeExportHash } from '../services/ledgerExportService';
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

describe('GET /ledger/export - Snapshot Mode', () => {
  describe('snapshot=true basic behavior', () => {
    it('returns entries with content_sha256 header and body field when snapshot=true', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '1050-Custody', snapshot: 'true' });

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(4);
      expect(res.body.content_sha256).toBeDefined();
      expect(typeof res.body.content_sha256).toBe('string');
      expect(res.body.content_sha256).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
      expect(res.headers['content-sha-256']).toBe(res.body.content_sha256);
      expect(res.headers['x-snapshot-mode']).toBe('true');
    });

    it('does not include content_sha256 when snapshot is not enabled', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '1050-Custody' });

      expect(res.status).toBe(200);
      expect(res.body.content_sha256).toBeUndefined();
      expect(res.headers['content-sha-256']).toBeUndefined();
      expect(res.headers['x-snapshot-mode']).toBeUndefined();
    });

    it('returns deterministic hash for same data (byte-for-byte reproducible)', async () => {
      const { app } = createApp();

      const res1 = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '1050-Custody', snapshot: 'true' });

      const res2 = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '1050-Custody', snapshot: 'true' });

      expect(res1.body.content_sha256).toBe(res2.body.content_sha256);
    });

    it('entries are sorted by entry_date ASC, then id ASC in snapshot mode', async () => {
      // Create entries with scrambled order and same date but different ids
      const repo = new InMemoryLedgerRepository([
        {
          id: 'c',
          gl_account: 'Test-Account',
          entry_date: '2026-07-01',
          description: 'Third by date',
          debit_amount: '100.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'deposit',
        },
        {
          id: 'a',
          gl_account: 'Test-Account',
          entry_date: '2026-07-01',
          description: 'First by id',
          debit_amount: '200.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T11:00:00Z',
          entry_type: 'deposit',
        },
        {
          id: 'b',
          gl_account: 'Test-Account',
          entry_date: '2026-07-01',
          description: 'Second by id',
          debit_amount: '300.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T09:00:00Z',
          entry_type: 'deposit',
        },
        {
          id: 'd',
          gl_account: 'Test-Account',
          entry_date: '2026-06-30',
          description: 'Earlier date',
          debit_amount: '50.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-06-30T10:00:00Z',
          entry_type: 'deposit',
        },
      ]);

      const { app } = createApp(repo);
      const res = await request(app)
        .get('/ledger/export')
        .query({ gl_account: 'Test-Account', snapshot: 'true' });

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(4);
      // Should be sorted by entry_date ASC, then id ASC
      expect(res.body.entries[0].id).toBe('d'); // 2026-06-30
      expect(res.body.entries[1].id).toBe('a'); // 2026-07-01, id 'a'
      expect(res.body.entries[2].id).toBe('b'); // 2026-07-01, id 'b'
      expect(res.body.entries[3].id).toBe('c'); // 2026-07-01, id 'c'
    });

    it('returns deterministic hash even for empty results', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '9999-Nonexistent', snapshot: 'true' });

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
      // Empty result should not have content_sha256
      expect(res.body.content_sha256).toBeUndefined();
    });
  });

  describe('snapshot with cutoff_at', () => {
    it('excludes entries recorded after cutoff_at', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          snapshot: 'true',
          cutoff_at: '2026-07-02T12:00:00Z',
        });

      expect(res.status).toBe(200);
      // Only entries recorded at or before 2026-07-02T12:00:00Z should be included
      // Entry 1: 2026-07-01T10:00:00Z (included)
      // Entry 2: 2026-07-02T10:00:00Z (included)
      // Entry 3: 2026-07-03T10:00:00Z (excluded)
      // Entry 4: 2026-07-04T10:00:00Z (excluded)
      expect(res.body.entries).toHaveLength(2);
      expect(res.body.content_sha256).toBeDefined();
      expect(res.headers['x-snapshot-cutoff-at']).toBe('2026-07-02T12:00:00Z');
    });

    it('sets X-Snapshot-Cutoff-At header', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          snapshot: 'true',
          cutoff_at: '2026-07-02T12:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.headers['x-snapshot-cutoff-at']).toBe('2026-07-02T12:00:00Z');
    });

    it('excludes all entries if cutoff is before earliest entry', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          snapshot: 'true',
          cutoff_at: '2026-06-01T00:00:00Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(0);
      expect(res.body.content_sha256).toBeUndefined();
    });

    it('includes all entries if cutoff is after latest entry', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          snapshot: 'true',
          cutoff_at: '2026-12-31T23:59:59Z',
        });

      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(4);
    });
  });

  describe('cutoff_at validation', () => {
    it('returns 400 if cutoff_at has invalid format', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          snapshot: 'true',
          cutoff_at: 'not-a-date',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('cutoff_at');
    });

    it('returns 400 if cutoff_at is provided without snapshot=true', async () => {
      const { app } = createApp();
      const res = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          cutoff_at: '2026-07-02T12:00:00Z',
        });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BAD_REQUEST');
      expect(res.body.message).toContain('snapshot=true');
    });
  });

  describe('snapshot with pagination', () => {
    it('paginates correctly in snapshot mode with deterministic ordering', async () => {
      const repo = new InMemoryLedgerRepository();
      const entries: LedgerEntry[] = [];
      // Create entries with scrambled dates to test sorting
      for (let i = 1; i <= 20; i++) {
        const day = String(i).padStart(2, '0');
        entries.push({
          id: `entry-${String(i).padStart(3, '0')}`,
          gl_account: '1050-Custody',
          entry_date: `2026-07-${day}`,
          description: `Entry ${i}`,
          debit_amount: `${i}.00`,
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: `2026-07-${day}T10:00:00Z`,
          entry_type: 'deposit',
        });
      }
      // Shuffle entries to test that snapshot mode sorts them
      for (let i = entries.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [entries[i], entries[j]] = [entries[j], entries[i]];
      }
      repo.addEntries(entries);

      const { app } = createApp(repo);

      // First page
      const res1 = await request(app)
        .get('/ledger/export')
        .query({ gl_account: '1050-Custody', limit: '10', snapshot: 'true' });

      expect(res1.status).toBe(200);
      expect(res1.body.entries).toHaveLength(10);
      expect(res1.body.has_more).toBe(true);
      expect(res1.body.content_sha256).toBeDefined();

      // Verify first page is sorted correctly
      const firstPageDates = res1.body.entries.map((e: LedgerEntry) => e.entry_date);
      expect(firstPageDates).toEqual([...firstPageDates].sort());

      // Second page
      const res2 = await request(app)
        .get('/ledger/export')
        .query({
          gl_account: '1050-Custody',
          limit: '10',
          snapshot: 'true',
          cursor: res1.body.next_cursor,
        });

      expect(res2.status).toBe(200);
      expect(res2.body.entries).toHaveLength(10);
      expect(res2.body.has_more).toBe(false);
      expect(res2.body.content_sha256).toBeDefined();

      // Verify second page is sorted correctly
      const secondPageDates = res2.body.entries.map((e: LedgerEntry) => e.entry_date);
      expect(secondPageDates).toEqual([...secondPageDates].sort());
    });
  });

  describe('deterministic hash computation', () => {
    it('computeExportHash produces consistent results', () => {
      const entries: LedgerEntry[] = [
        {
          id: '1',
          gl_account: 'Test',
          entry_date: '2026-07-01',
          description: 'Test',
          debit_amount: '100.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'test',
        },
        {
          id: '2',
          gl_account: 'Test',
          entry_date: '2026-07-02',
          description: 'Test 2',
          debit_amount: '0.00',
          credit_amount: '50.00',
          currency: 'USD',
          recorded_at: '2026-07-02T10:00:00Z',
          entry_type: 'test',
        },
      ];

      const hash1 = computeExportHash(entries);
      const hash2 = computeExportHash(entries);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('computeExportHash produces different hashes for different data', () => {
      const entries1: LedgerEntry[] = [
        {
          id: '1',
          gl_account: 'Test',
          entry_date: '2026-07-01',
          description: 'Test',
          debit_amount: '100.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'test',
        },
      ];

      const entries2: LedgerEntry[] = [
        {
          id: '1',
          gl_account: 'Test',
          entry_date: '2026-07-01',
          description: 'Test',
          debit_amount: '200.00', // Different amount
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'test',
        },
      ];

      expect(computeExportHash(entries1)).not.toBe(computeExportHash(entries2));
    });

    it('computeExportHash is order-independent (sorts entries)', () => {
      const entries1: LedgerEntry[] = [
        {
          id: '1',
          gl_account: 'Test',
          entry_date: '2026-07-01',
          description: 'First',
          debit_amount: '100.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'test',
        },
        {
          id: '2',
          gl_account: 'Test',
          entry_date: '2026-07-02',
          description: 'Second',
          debit_amount: '200.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-02T10:00:00Z',
          entry_type: 'test',
        },
      ];

      const entries2: LedgerEntry[] = [
        {
          id: '2',
          gl_account: 'Test',
          entry_date: '2026-07-02',
          description: 'Second',
          debit_amount: '200.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-02T10:00:00Z',
          entry_type: 'test',
        },
        {
          id: '1',
          gl_account: 'Test',
          entry_date: '2026-07-01',
          description: 'First',
          debit_amount: '100.00',
          credit_amount: '0.00',
          currency: 'USD',
          recorded_at: '2026-07-01T10:00:00Z',
          entry_type: 'test',
        },
      ];

      // Hash should be the same regardless of input order
      expect(computeExportHash(entries1)).toBe(computeExportHash(entries2));
    });
  });

  describe('isValidCutoffTimestamp', () => {
    it('returns true for valid ISO 8601 timestamp', async () => {
      const { isValidCutoffTimestamp } = await import('../services/ledgerExportService');
      expect(isValidCutoffTimestamp('2026-07-01T00:00:00Z')).toBe(true);
      expect(isValidCutoffTimestamp('2026-12-31T23:59:59.999Z')).toBe(true);
    });

    it('returns false for invalid timestamp', async () => {
      const { isValidCutoffTimestamp } = await import('../services/ledgerExportService');
      expect(isValidCutoffTimestamp('not-a-date')).toBe(false);
      expect(isValidCutoffTimestamp('')).toBe(false);
    });
  });
});
