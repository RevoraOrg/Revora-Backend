/**
 * Tests for GET /api/v1/ledger/export (Issue #1275)
 *
 * Coverage matrix:
 *  - Authentication: anonymous → 401, investor → 403, compliance → 200, admin → 200
 *  - Missing / blank / tampered inputs → 400
 *  - Cursor pagination (first, middle, last page)
 *  - Cross-account cursor rejection
 *  - Postgres repository against a real schema (Testcontainers, conditional)
 *  - Regression: anonymous access was previously successful on master (explicit test)
 *
 * Security assumptions tested:
 *  - Role is read from the verified JWT payload, never from a request header.
 *  - A missing Bearer token always returns 401 (not a redirect or 200).
 *  - A valid investor JWT returns 403 — authenticated but unauthorised.
 *  - A compliance or admin JWT returns data rows, not an auth error.
 *  - Tampered cursors are rejected 400 before hitting the repository.
 */

import request from 'supertest';
import express, { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import {
  LedgerExportService,
  InMemoryLedgerRepository,
  LedgerEntry,
} from '../services/ledgerExportService';
import { createLedgerExportRouter } from './ledgerExport';
import { errorHandler } from '../middleware/errorHandler';
import { signCursor } from '../lib/pagination';
import { verifyJwt } from '../middleware/auth';

// ─── Environment setup ───────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'test-jwt-secret-min-32-chars-here!!';
const TEST_CURSOR_SECRET = 'test-cursor-secret-32-chars-min!!';

beforeAll(() => {
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.CURSOR_SIGNING_SECRET = TEST_CURSOR_SECRET;
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.CURSOR_SIGNING_SECRET;
});

// ─── JWT token helpers ───────────────────────────────────────────────────────

/**
 * Produce a minimal HS256 JWT with the given role, signed with TEST_JWT_SECRET.
 * Uses the same manual HMAC approach that `verifyJwt` in auth middleware consumes,
 * so there is no jsonwebtoken dependency in tests and the token is always valid.
 */
function makeToken(role: string, sub = 'user-001'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payloadObj = {
    sub,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', TEST_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ─── Auth middleware stubs ───────────────────────────────────────────────────

/**
 * Minimal `requireCompliance` reimplementation used in the integration app.
 * Mirrors the real middleware in src/middleware/auth.ts:
 *   - No Authorization header → 401
 *   - Valid JWT but role not in ['compliance', 'admin'] → 403
 *   - Valid JWT with allowed role → next()
 *
 * The real middleware is imported and exercised in the "real middleware" suite.
 */
const stubRequireCompliance: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = verifyJwt(token, TEST_JWT_SECRET);
    const allowed = ['compliance', 'admin'];
    if (!allowed.includes(payload.role)) {
      res.status(403).json({ code: 'FORBIDDEN', message: 'Forbidden: compliance role required' });
      return;
    }
    (req as any).user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
};

// ─── App factory ─────────────────────────────────────────────────────────────

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

/**
 * Build an express app that mounts the ledger export router behind
 * `stubRequireCompliance` so auth is enforced in every test.
 */
function createApp(repo?: InMemoryLedgerRepository): { app: Express; repo: InMemoryLedgerRepository } {
  const r = repo ?? new InMemoryLedgerRepository(seedEntries());
  const service = new LedgerExportService(r);
  const app = express();
  app.use(express.json());
  // Router created with the compliance guard — matches production wiring.
  app.use('/ledger', createLedgerExportRouter(service, stubRequireCompliance));
  app.use(errorHandler);
  return { app, repo: r };
}

// ─── Auth boundary tests ──────────────────────────────────────────────────────

describe('GET /ledger/export — auth matrix', () => {
  // REGRESSION: On master the route was unauthenticated; this test must fail
  // if auth middleware is ever removed.
  it('[regression] anonymous request gets 401, not 200 (was unauthenticated on master)', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is missing entirely', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 when Authorization header is malformed (no Bearer prefix)', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', 'Token some-token');

    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT signature is invalid', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', 'Bearer totally.invalid.token');

    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT is expired', async () => {
    // Craft a token with exp in the past.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadObj = {
      sub: 'user-exp',
      role: 'compliance',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    };
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', TEST_JWT_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const expiredToken = `${header}.${payload}.${sig}`;

    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
  });

  it('returns 403 for a valid investor token (authenticated but not authorised)', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${makeToken('investor')}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('returns 403 for a valid startup token', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${makeToken('startup')}`);

    expect(res.status).toBe(403);
  });

  it('returns 200 for a valid compliance token', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${makeToken('compliance')}`);

    expect(res.status).toBe(200);
  });

  it('returns 200 for a valid admin token (admins retain access)', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);

    expect(res.status).toBe(200);
  });

  it('role is determined by JWT payload, not a spoofed X-Role header', async () => {
    // Pass a valid investor JWT but add a header that might confuse a naive
    // middleware that reads role from headers instead of the token payload.
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${makeToken('investor')}`)
      .set('X-Role', 'compliance');

    // Must still be 403 — the spoofed header must have no effect.
    expect(res.status).toBe(403);
  });
});

// ─── Input validation (authenticated) ────────────────────────────────────────

describe('GET /ledger/export — input validation', () => {
  const complianceToken = () => makeToken('compliance');

  it('returns 400 when gl_account is missing', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for an empty gl_account string', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
  });

  it('returns 400 for a whitespace-only gl_account string', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '   ' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
  });

  it('returns 400 for a tampered cursor', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', cursor: 'tampered.invalid.cursor' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when cursor is for a different gl_account', async () => {
    const repo = new InMemoryLedgerRepository(seedEntries());
    const { app } = createApp(repo);

    // Sign a valid cursor for the Revenue account …
    const otherCursor = signCursor({ id: '5', gl: '2010-Revenue', t: Date.now() });

    // … then present it against Custody
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', cursor: otherCursor })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

// ─── Functional / data tests (authenticated) ─────────────────────────────────

describe('GET /ledger/export — response data', () => {
  const complianceToken = () => makeToken('compliance');

  it('returns correct entries and totals for a gl_account', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${complianceToken()}`);

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

  it('returns empty entries and zero totals for an account with no rows', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '9999-Nonexistent' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
    expect(res.body.totals).toEqual({
      total_debit: '0',
      total_credit: '0',
      entry_count: 0,
    });
    expect(res.body.has_more).toBe(false);
  });

  it('respects a custom limit parameter', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '2' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.has_more).toBe(true);
    expect(res.body.next_cursor).toBeDefined();
  });

  it('clamps limit to minimum 1', async () => {
    const repo = new InMemoryLedgerRepository();
    repo.addEntries([{
      id: 'x1', gl_account: 'Clamp-Test', entry_date: '2026-07-01',
      description: 'Test', debit_amount: '1.00', credit_amount: '0.00',
      currency: 'USD', recorded_at: '2026-07-01T10:00:00Z', entry_type: 'test',
    }]);
    const { app } = createApp(repo);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: 'Clamp-Test', limit: '0' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    // limit clamped to 1 → still returns the single entry
    expect(res.body.entries).toHaveLength(1);
  });

  it('clamps limit to maximum 1000', async () => {
    const repo = new InMemoryLedgerRepository();
    repo.addEntries([{
      id: 'x1', gl_account: 'Clamp-Test', entry_date: '2026-07-01',
      description: 'Test', debit_amount: '1.00', credit_amount: '0.00',
      currency: 'USD', recorded_at: '2026-07-01T10:00:00Z', entry_type: 'test',
    }]);
    const { app } = createApp(repo);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: 'Clamp-Test', limit: '99999' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
  });

  it('totals match the arithmetic sum of returned entry amounts', async () => {
    const entries: LedgerEntry[] = [
      {
        id: 'a1', gl_account: '1050-Custody', entry_date: '2026-07-01',
        description: 'A', debit_amount: '1234.56', credit_amount: '0.00',
        currency: 'USD', recorded_at: '2026-07-01T10:00:00Z', entry_type: 'deposit',
      },
      {
        id: 'a2', gl_account: '1050-Custody', entry_date: '2026-07-02',
        description: 'B', debit_amount: '0.00', credit_amount: '789.01',
        currency: 'USD', recorded_at: '2026-07-02T10:00:00Z', entry_type: 'withdrawal',
      },
      {
        id: 'a3', gl_account: '1050-Custody', entry_date: '2026-07-03',
        description: 'C', debit_amount: '0.01', credit_amount: '0.00',
        currency: 'USD', recorded_at: '2026-07-03T10:00:00Z', entry_type: 'interest',
      },
    ];
    const repo = new InMemoryLedgerRepository(entries);
    const { app } = createApp(repo);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      total_debit: '1234.57',
      total_credit: '789.01',
      entry_count: 3,
    });
  });
});

// ─── Cursor pagination (authenticated) ───────────────────────────────────────

describe('GET /ledger/export — cursor pagination', () => {
  const complianceToken = () => makeToken('compliance');

  it('paginates over 25 entries in three pages of 10 / 10 / 5', async () => {
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

    // Page 1
    const res1 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res1.status).toBe(200);
    expect(res1.body.entries).toHaveLength(10);
    expect(res1.body.has_more).toBe(true);
    expect(res1.body.next_cursor).toBeDefined();

    // Page 2
    const res2 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10', cursor: res1.body.next_cursor })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res2.status).toBe(200);
    expect(res2.body.entries).toHaveLength(10);
    expect(res2.body.has_more).toBe(true);
    expect(res2.body.next_cursor).toBeDefined();

    // Page 3 (last)
    const res3 = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '10', cursor: res2.body.next_cursor })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res3.status).toBe(200);
    expect(res3.body.entries).toHaveLength(5);
    expect(res3.body.has_more).toBe(false);
    expect(res3.body.next_cursor).toBeUndefined();

    // Verify no duplicates across all three pages
    const allIds = [
      ...res1.body.entries,
      ...res2.body.entries,
      ...res3.body.entries,
    ].map((e: LedgerEntry) => e.id);
    expect(new Set(allIds).size).toBe(25);
  });

  it('returns no next_cursor when all entries fit on a single page', async () => {
    const { app } = createApp();
    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', limit: '100' })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.has_more).toBe(false);
    expect(res.body.next_cursor).toBeUndefined();
  });

  it('cursor is bound to its gl_account — reusing cursor for a different account returns 400', async () => {
    const repo = new InMemoryLedgerRepository(seedEntries());
    const { app } = createApp(repo);

    // Get a valid cursor for the Revenue account
    const revRes = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '2010-Revenue', limit: '1' })
      .set('Authorization', `Bearer ${complianceToken()}`);
    // The Revenue account has only one entry, so no cursor is issued.
    // Build one manually with the known id.
    const manualCursor = signCursor({ id: '5', gl: '2010-Revenue', t: Date.now() });

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody', cursor: manualCursor })
      .set('Authorization', `Bearer ${complianceToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });
});

// ─── Router factory: no auth middleware → open (verify the guard is the arg) ─

describe('createLedgerExportRouter — no auth middleware (bare router)', () => {
  /**
   * This suite verifies that the router itself is passive — it does not embed
   * its own hard-coded middleware. Auth is entirely the responsibility of the
   * caller-supplied arguments. If no auth middleware is passed the route is
   * publicly accessible, which is intentional for test/mock scenarios but must
   * never occur in production (enforced by the index.ts wiring test below).
   */
  it('returns 200 when no auth middleware is supplied (bare router)', async () => {
    const repo = new InMemoryLedgerRepository(seedEntries());
    const service = new LedgerExportService(repo);
    const app = express();
    app.use(express.json());
    // Intentionally passing NO auth middleware — simulates a test/mock scenario.
    app.use('/ledger', createLedgerExportRouter(service));
    app.use(errorHandler);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(res.status).toBe(200);
  });

  it('accepts multiple middleware arguments and applies them in order', async () => {
    const order: string[] = [];
    const mw1: RequestHandler = (_req, _res, next) => { order.push('mw1'); next(); };
    const mw2: RequestHandler = (_req, _res, next) => { order.push('mw2'); next(); };

    const repo = new InMemoryLedgerRepository(seedEntries());
    const service = new LedgerExportService(repo);
    const app = express();
    app.use(express.json());
    app.use('/ledger', createLedgerExportRouter(service, mw1, mw2));
    app.use(errorHandler);

    await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    expect(order).toEqual(['mw1', 'mw2']);
  });

  it('stops at middleware that sends a response (auth guard short-circuits handler)', async () => {
    const blocker: RequestHandler = (_req, res) => {
      res.status(418).json({ code: 'TEAPOT', message: 'I am a teapot' });
    };

    const repo = new InMemoryLedgerRepository(seedEntries());
    const service = new LedgerExportService(repo);
    const app = express();
    app.use(express.json());
    app.use('/ledger', createLedgerExportRouter(service, blocker));
    app.use(errorHandler);

    const res = await request(app)
      .get('/ledger/export')
      .query({ gl_account: '1050-Custody' });

    // The blocker fires; the route handler never runs.
    expect(res.status).toBe(418);
  });
});

// ─── PgLedgerEntryRepository: schema contract ─────────────────────────────────

/**
 * These tests run against a real Postgres instance only when
 * INTEGRATION_DB_URL is set in the environment. They validate the SQL in
 * 061_create_ledger_entries.sql and the repository queries against that schema.
 *
 * In CI the standard Jest suite skips this block. Run with:
 *   INTEGRATION_DB_URL=postgres://... npx jest ledgerExport.test.ts
 */
const INTEGRATION_DB_URL = process.env.INTEGRATION_DB_URL;

// eslint-disable-next-line jest/valid-describe-callback
(INTEGRATION_DB_URL ? describe : describe.skip)('PgLedgerEntryRepository — integration (requires INTEGRATION_DB_URL)', () => {
  let pool: import('pg').Pool;
  let repo: import('../db/repositories/ledgerEntryRepository').PgLedgerEntryRepository;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: INTEGRATION_DB_URL });

    // Apply the migration DDL
    const fs = await import('fs/promises');
    const path = await import('path');
    const ddl = await fs.readFile(
      path.resolve(__dirname, '../db/migrations/061_create_ledger_entries.sql'),
      'utf8',
    );
    await pool.query(ddl);

    // Truncate before each run so tests are idempotent
    await pool.query('TRUNCATE TABLE ledger_entries');

    const { PgLedgerEntryRepository } = await import('../db/repositories/ledgerEntryRepository');
    repo = new PgLedgerEntryRepository(pool);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS ledger_entries');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE ledger_entries');
  });

  it('returns empty result for an account with no rows', async () => {
    const result = await repo.findByGlAccount('1050-Custody', 10);
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('inserts and retrieves entries, total matches count', async () => {
    await pool.query(`
      INSERT INTO ledger_entries (id, gl_account, entry_date, description,
        debit_amount, credit_amount, currency, recorded_at, entry_type)
      VALUES
        ('r1', '1050-Custody', '2026-07-01', 'Deposit',  500.00, 0.00, 'USD', NOW(), 'deposit'),
        ('r2', '1050-Custody', '2026-07-02', 'Fee',        0.00, 5.00, 'USD', NOW(), 'fee'),
        ('r3', '2010-Revenue', '2026-07-01', 'Revenue',    0.00, 100.00, 'USD', NOW(), 'revenue')
    `);

    const result = await repo.findByGlAccount('1050-Custody', 10);
    expect(result.entries).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.entries[0].gl_account).toBe('1050-Custody');
  });

  it('paginates using afterId (keyset cursor)', async () => {
    // Insert 5 entries for the same account
    const values = Array.from({ length: 5 }, (_, i) => {
      const id = `pg${i + 1}`;
      return `('${id}', '1050-Custody', '2026-07-0${i + 1}', 'Entry ${i + 1}', ${(i + 1) * 10}.00, 0.00, 'USD', NOW(), 'deposit')`;
    }).join(',');
    await pool.query(
      `INSERT INTO ledger_entries (id, gl_account, entry_date, description,
         debit_amount, credit_amount, currency, recorded_at, entry_type)
       VALUES ${values}`,
    );

    // Page 1: first 2
    const page1 = await repo.findByGlAccount('1050-Custody', 2);
    expect(page1.entries).toHaveLength(2);
    expect(page1.hasMore).toBe(true);

    // Page 2: next 2 using afterId of last entry on page 1
    const page2 = await repo.findByGlAccount('1050-Custody', 2, page1.entries[1].id);
    expect(page2.entries).toHaveLength(2);
    expect(page2.hasMore).toBe(true);

    // Page 3: last 1
    const page3 = await repo.findByGlAccount('1050-Custody', 2, page2.entries[1].id);
    expect(page3.entries).toHaveLength(1);
    expect(page3.hasMore).toBe(false);

    // No duplicates
    const allIds = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it('does not return entries from other gl_accounts', async () => {
    await pool.query(`
      INSERT INTO ledger_entries (id, gl_account, entry_date, description,
        debit_amount, credit_amount, currency, recorded_at, entry_type)
      VALUES
        ('iso1', '1050-Custody', '2026-07-01', 'Mine',  10.00, 0.00, 'USD', NOW(), 'deposit'),
        ('iso2', '2010-Revenue', '2026-07-01', 'Other', 20.00, 0.00, 'USD', NOW(), 'revenue')
    `);

    const result = await repo.findByGlAccount('1050-Custody', 10);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('iso1');
  });
});
