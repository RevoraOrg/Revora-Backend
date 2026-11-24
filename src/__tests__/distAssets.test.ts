import { spawnSync } from 'child_process';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';

const repoRoot = path.resolve(__dirname, '../..');

jest.mock(
  'swagger-ui-express',
  () => ({
    serve: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    setup: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  }),
  { virtual: true }
);

describe('Docker / dist asset shipping', () => {
  beforeAll(() => {
    // tsc may exit non-zero due to pre-existing type errors while still emitting dist/.
    spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
  }, 60000);

  it('copies migrate.js, SQL migrations, and openapi.yaml into dist/', () => {
    const distMigrate = path.join(repoRoot, 'dist/db/migrate.js');
    const distMigrationsDir = path.join(repoRoot, 'dist/db/migrations');
    const distOpenApi = path.join(repoRoot, 'dist/docs/openapi.yaml');

    expect(fs.existsSync(distMigrate)).toBe(true);
    expect(fs.existsSync(distMigrationsDir)).toBe(true);
    expect(fs.existsSync(distOpenApi)).toBe(true);

    const srcSqlCount = fs
      .readdirSync(path.join(repoRoot, 'src/db/migrations'))
      .filter((entry) => entry.endsWith('.sql')).length;
    const distSqlFiles = fs
      .readdirSync(distMigrationsDir)
      .filter((entry) => entry.endsWith('.sql'));
    expect(distSqlFiles.length).toBe(srcSqlCount);
  });

  it('serves /openapi.yaml from dist/routes/apiDocs.js', async () => {
    const distApiDocsPath = path.join(repoRoot, 'dist/routes/apiDocs.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createApiDocsRouter } = require(distApiDocsPath) as {
      createApiDocsRouter: () => express.Router;
    };

    const app = express();
    app.use(createApiDocsRouter());

    const res = await request(app).get('/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('openapi:');
  });

  it('runs migrate script against dist/db/migrate.js when src/ is absent (container layout)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revora-dist-migrate-'));
    try {
      const pkgRaw = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgRaw) as { scripts: { migrate: string } };

      fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tmpDir, 'package.json'));
      fs.cpSync(path.join(repoRoot, 'dist'), path.join(tmpDir, 'dist'), { recursive: true });
      fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmpDir, 'node_modules'), 'dir');

      const result = spawnSync('sh', ['-c', pkg.scripts.migrate], {
        cwd: tmpDir,
        env: { ...process.env, DATABASE_URL: '' },
        encoding: 'utf8',
      });

      expect(result.stderr).not.toContain('Cannot find module');
      expect(result.stderr).toContain('DATABASE_URL environment variable is not set');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
