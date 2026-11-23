/**
 * Route tests for the investor statement fetch endpoint (#874).
 *
 * Covers authorization boundaries (IDOR), integrity re-verification (sha256
 * must match before serving), and failure paths.
 */

import request from 'supertest';
import express, { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { createStatementsRouter } from './statements';
import { errorHandler } from '../middleware/errorHandler';
import { Errors } from '../lib/errors';
import { PdfRenderJobRow } from '../db/repositories/pdfRenderJobRepository';

function makeJobRow(overrides: Partial<PdfRenderJobRow> = {}): PdfRenderJobRow {
  return {
    id: 'stmt-1',
    batch_id: 'batch-1',
    investor_id: 'inv-1',
    period_id: '2026-07',
    status: 'completed',
    attempts: 1,
    available_at: new Date('2026-07-01T00:00:00.000Z'),
    claimed_at: null,
    storage_key: 'statements/2026-07/inv-1.pdf',
    checksum: 'f'.repeat(64),
    error: null,
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n% test statement\n%%EOF\n', 'utf8');

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createApp(opts: {
  user?: { id: string; role: string } | null;
  job?: PdfRenderJobRow | null;
  storedBytes?: Buffer | null;
  storageThrows?: boolean;
}) {
  const { user, job, storedBytes, storageThrows } = opts;

  const verifyJWT = (req: Request, _res: Response, next: NextFunction) => {
    if (user === null || user === undefined) {
      next(Errors.unauthorized());
      return;
    }
    (req as unknown as { user?: { id: string; role: string } }).user = user;
    next();
  };

  const jobRepo = {
    findCompletedByInvestorAndPeriod: jest.fn().mockResolvedValue(job ?? null),
  };
  const storage = {
    getObject: jest.fn().mockImplementation(async () => {
      if (storageThrows) throw new Error('storage down');
      return storedBytes ?? null;
    }),
  };

  const app = express();
  app.use(express.json());
  app.use(
    '/statements',
    createStatementsRouter({
      jobRepo,
      storage,
      verifyJWT,
    })
  );
  app.use(errorHandler);
  return { app, jobRepo, storage };
}

describe('GET /statements/:periodId/:investorId', () => {
  it('serves the PDF after re-verifying the persisted sha256', async () => {
    const bytes = PDF_BYTES;
    const checksum = sha256(bytes);
    const job = makeJobRow({ checksum });
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job,
      storedBytes: bytes,
    });

    const res = await request(app).get('/statements/2026-07/inv-1');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-statement-sha256']).toBe(checksum);
    expect(res.headers.etag).toBe(`"${checksum}"`);
    expect(res.body).toEqual(bytes);
  });

  it('allows admin/compliance to fetch any investor statement', async () => {
    const bytes = PDF_BYTES;
    const checksum = sha256(bytes);
    const { app } = createApp({
      user: { id: 'admin-1', role: 'admin' },
      job: makeJobRow({ checksum }),
      storedBytes: bytes,
    });

    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(200);

    const compliance = createApp({
      user: { id: 'comp-1', role: 'compliance' },
      job: makeJobRow({ checksum }),
      storedBytes: bytes,
    });
    const res2 = await request(compliance.app).get('/statements/2026-07/inv-1');
    expect(res2.status).toBe(200);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const { app } = createApp({ user: null });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(401);
  });

  it('rejects an investor fetching another investor statement with 403 (IDOR boundary)', async () => {
    const { app } = createApp({ user: { id: 'inv-2', role: 'investor' } });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(403);
  });

  it('rejects non-privileged non-investor roles with 403', async () => {
    const { app } = createApp({ user: { id: 'startup-1', role: 'startup' } });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(403);
  });

  it('rejects whitespace-only or oversized path parameters with 400', async () => {
    const { app } = createApp({ user: { id: 'inv-1', role: 'investor' } });
    const res = await request(app).get('/statements/%20/inv-1');
    expect(res.status).toBe(400);

    const tooLong = 'x'.repeat(300);
    const res2 = await request(app).get(`/statements/${tooLong}/inv-1`);
    expect(res2.status).toBe(400);
  });

  it('returns 404 when no completed statement exists', async () => {
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job: null,
    });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('returns 404 when the artifact is missing from storage', async () => {
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job: makeJobRow({ checksum: sha256(PDF_BYTES) }),
      storedBytes: null,
    });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the job row has no storage_key or checksum', async () => {
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job: makeJobRow({ storage_key: null, checksum: null }),
    });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(404);
  });

  it('rejects tampered bytes with 409 instead of serving them', async () => {
    const job = makeJobRow({ checksum: 'a'.repeat(64) }); // persisted hash disagrees with bytes
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job,
      storedBytes: PDF_BYTES,
    });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('surfaces storage failures as 500 without leaking internals', async () => {
    const { app } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job: makeJobRow({ checksum: sha256(PDF_BYTES) }),
      storedBytes: PDF_BYTES,
      storageThrows: true,
    });
    const res = await request(app).get('/statements/2026-07/inv-1');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('storage down');
  });

  it('does not call storage when the job is missing', async () => {
    const { app, storage } = createApp({
      user: { id: 'inv-1', role: 'investor' },
      job: null,
    });
    await request(app).get('/statements/2026-07/inv-1');
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});
