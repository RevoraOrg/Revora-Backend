/**
 * Integration-style tests for the compliance router (sanctions diff endpoints).
 *
 * All database access is faked via in-memory stubs. JWT tokens are produced
 * using the same HMAC-SHA256 scheme used by the real auth middleware so the
 * tests exercise the real `requireCompliance` guard.
 *
 * Security coverage:
 * - Unauthenticated requests → 401
 * - Insufficient role (investor, startup, admin not in allowed set when
 *   only compliance allowed) → no — compliance allows admin too, tested
 * - Forbidden role (investor) → 403
 * - Compliance role → 200
 * - Admin role → 200 (also allowed)
 * - Not-found versions → 404
 * - Invalid source param → 400
 * - Changelog returned as attachment with sanitised filename
 */
import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createComplianceRouter } from './compliance';
import { SanctionsListVersionsRepository, SanctionsListVersion, SanctionsListDiffDetail } from '../db/repositories/sanctionsListVersionsRepository';
import { SanctionsListDiffService } from '../services/sanctionsListDiffService';
import { errorHandler } from '../middleware/errorHandler';

// ─── JWT helpers ──────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-jwt-secret';

function makeToken(sub: string, role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub, role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', TEST_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function authHeader(role: string, sub = 'user-1') {
  return { Authorization: `Bearer ${makeToken(sub, role)}` };
}

// ─── In-memory repo stubs ─────────────────────────────────────────────────────

function makeVersion(overrides: Partial<SanctionsListVersion> = {}): SanctionsListVersion {
  return {
    id: 'ver-abc',
    list_source: 'ofac',
    version: '2024-01-01',
    raw_payload_hash: 'a'.repeat(64),
    parse_hash: 'b'.repeat(64),
    entry_count: 5,
    diff_summary: { added: 2, removed: 1, modified: 0, total_changes: 3 },
    diff_size: 3,
    previous_version_id: null,
    signature_valid: true,
    loaded_at: new Date('2024-01-01T00:00:00Z'),
    created_at: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDiffDetail(overrides: Partial<SanctionsListDiffDetail> = {}): SanctionsListDiffDetail {
  return {
    id: 'dd-1',
    version_id: 'ver-abc',
    entity_uid: 'uid-1',
    entity_name: 'Evil Corp',
    change_type: 'added',
    previous_data: null,
    new_data: { uid: 'uid-1', name: 'Evil Corp' },
    created_at: new Date(),
    ...overrides,
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

function makeApp(
  repoOverrides: Partial<SanctionsListVersionsRepository> = {},
  svcOverrides: Partial<SanctionsListDiffService> = {},
) {
  process.env.JWT_SECRET = TEST_SECRET;

  const repo = {
    findVersionById: jest.fn().mockResolvedValue(makeVersion()),
    findVersionsBySource: jest.fn().mockResolvedValue([makeVersion()]),
    findLatestVersion: jest.fn().mockResolvedValue(makeVersion()),
    findDiffDetailsByVersionId: jest.fn().mockResolvedValue([makeDiffDetail()]),
    createVersion: jest.fn(),
    createDiffDetail: jest.fn(),
    findVersionsAfterDate: jest.fn().mockResolvedValue([]),
    deleteVersionsOlderThan: jest.fn().mockResolvedValue(0),
    findDiffDetailsByChangeType: jest.fn().mockResolvedValue([]),
    findDiffDetailsByEntityUid: jest.fn().mockResolvedValue([]),
    generateChangelog: jest.fn().mockResolvedValue(
      'Sanctions List Changelog\n======================\nSource: ofac\nVersion: 2024-01-01\nTotal Changes: 3\n\nAdded Entities (1):\n  - Evil Corp (UID: uid-1)\n\n',
    ),
    ...repoOverrides,
  } as unknown as SanctionsListVersionsRepository;

  const svc = {
    generateChangelog: jest.fn().mockImplementation((id: string) =>
      (repo as any).generateChangelog(id),
    ),
    recordLoadWithDiff: jest.fn(),
    computeDiff: jest.fn(),
    applyRetentionPolicy: jest.fn(),
    ...svcOverrides,
  } as unknown as SanctionsListDiffService;

  const app = express();
  app.use(express.json());
  app.use('/compliance', createComplianceRouter(repo, svc));
  app.use(errorHandler);

  return { app, repo, svc };
}

afterEach(() => {
  delete process.env.JWT_SECRET;
  jest.restoreAllMocks();
});

// ─── Auth guard tests ─────────────────────────────────────────────────────────

describe('Compliance routes — authentication', () => {
  it('returns 401 when no Authorization header is provided', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/compliance/sanctions-versions');
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header is malformed', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });

  it('returns 401 when the JWT is expired', async () => {
    process.env.JWT_SECRET = TEST_SECRET;
    const { app } = makeApp();
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u1', role: 'compliance', iat: 1000, exp: 1001 }),
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', TEST_SECRET).update(`${header}.${payload}`).digest('base64url');
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set('Authorization', `Bearer ${header}.${payload}.${sig}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 when role is investor', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('investor'));
    expect(res.status).toBe(403);
  });

  it('returns 403 when role is startup', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('startup'));
    expect(res.status).toBe(403);
  });

  it('returns 200 when role is compliance', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
  });

  it('returns 200 when role is admin (also permitted)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
  });
});

// ─── GET /sanctions-versions ──────────────────────────────────────────────────

describe('GET /compliance/sanctions-versions', () => {
  it('returns a list of latest versions from all sources when no source param given', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    expect(res.body.versions).toBeDefined();
    expect(Array.isArray(res.body.versions)).toBe(true);
  });

  it('returns filtered versions when source param is provided', async () => {
    const { app, repo } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions?source=ofac')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    expect(repo.findVersionsBySource).toHaveBeenCalledWith('ofac', expect.any(Number));
  });

  it('returns 400 for an invalid source param', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions?source=invalid_source')
      .set(authHeader('compliance'));
    expect(res.status).toBe(400);
  });

  it('respects the limit query param', async () => {
    const { app, repo } = makeApp();
    await request(app)
      .get('/compliance/sanctions-versions?source=ofac&limit=10')
      .set(authHeader('compliance'));
    expect(repo.findVersionsBySource).toHaveBeenCalledWith('ofac', 10);
  });

  it('caps limit at 1000', async () => {
    const { app, repo } = makeApp();
    await request(app)
      .get('/compliance/sanctions-versions?source=ofac&limit=99999')
      .set(authHeader('compliance'));
    expect(repo.findVersionsBySource).toHaveBeenCalledWith('ofac', 1000);
  });

  it('uses default limit of 100 when limit param is absent', async () => {
    const { app, repo } = makeApp();
    await request(app)
      .get('/compliance/sanctions-versions?source=ofac')
      .set(authHeader('compliance'));
    expect(repo.findVersionsBySource).toHaveBeenCalledWith('ofac', 100);
  });

  it('filters out null values when no versions exist for a source', async () => {
    const { app } = makeApp({ findLatestVersion: jest.fn().mockResolvedValue(null) });
    const res = await request(app)
      .get('/compliance/sanctions-versions')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    expect(res.body.versions.every((v: unknown) => v !== null)).toBe(true);
  });
});

// ─── GET /sanctions-versions/:versionId ──────────────────────────────────────

describe('GET /compliance/sanctions-versions/:versionId', () => {
  it('returns version and diff_details for a valid versionId', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions/ver-abc')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    expect(res.body.version).toBeDefined();
    expect(res.body.diff_details).toBeDefined();
    expect(Array.isArray(res.body.diff_details)).toBe(true);
  });

  it('returns 404 when the version does not exist', async () => {
    const { app } = makeApp({ findVersionById: jest.fn().mockResolvedValue(null) });
    const res = await request(app)
      .get('/compliance/sanctions-versions/nonexistent')
      .set(authHeader('compliance'));
    expect(res.status).toBe(404);
  });

  it('returns the correct version fields', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions/ver-abc')
      .set(authHeader('compliance'));
    expect(res.body.version.id).toBe('ver-abc');
    expect(res.body.version.list_source).toBe('ofac');
    expect(res.body.version.entry_count).toBe(5);
  });

  it('surfaces diff_details with change_type information', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-versions/ver-abc')
      .set(authHeader('compliance'));
    const detail = res.body.diff_details[0];
    expect(detail.change_type).toBe('added');
    expect(detail.entity_name).toBe('Evil Corp');
  });
});

// ─── GET /sanctions-changelog/:versionId ─────────────────────────────────────

describe('GET /compliance/sanctions-changelog/:versionId', () => {
  it('returns 200 with text/plain content-type', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('sets Content-Disposition attachment header', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('compliance'));
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.txt');
  });

  it('includes source and version in the filename', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('compliance'));
    expect(res.headers['content-disposition']).toContain('ofac');
  });

  it('returns 404 when the version does not exist', async () => {
    const { app } = makeApp({ findVersionById: jest.fn().mockResolvedValue(null) });
    const res = await request(app)
      .get('/compliance/sanctions-changelog/nonexistent')
      .set(authHeader('compliance'));
    expect(res.status).toBe(404);
  });

  it('response body contains changelog text', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('compliance'));
    expect(res.text).toContain('Sanctions List Changelog');
    expect(res.text).toContain('ofac');
  });

  it('sanitises special characters from the filename', async () => {
    const { app } = makeApp({
      findVersionById: jest.fn().mockResolvedValue(
        makeVersion({ list_source: 'ofac', version: '../../../etc/passwd' }),
      ),
    });
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('compliance'));
    expect(res.status).toBe(200);
    // Filename must not contain directory traversal sequences
    const disposition = res.headers['content-disposition'];
    expect(disposition).not.toContain('..');
    expect(disposition).not.toContain('/');
  });

  it('returns 401 for unauthenticated requests', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/compliance/sanctions-changelog/ver-abc');
    expect(res.status).toBe(401);
  });

  it('returns 403 for investor role', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .get('/compliance/sanctions-changelog/ver-abc')
      .set(authHeader('investor'));
    expect(res.status).toBe(403);
  });
});
