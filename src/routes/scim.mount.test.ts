/**
 * @file src/routes/scim.mount.test.ts
 * @description The SCIM router is wired into `createApp` (#1300), and only when
 * `SCIM_TOKEN` is configured. Each case loads `src/index.ts` in an isolated
 * module registry so the env snapshot taken by `src/config/env.ts` matches it.
 */
import request from 'supertest';
import type { Express } from 'express';

const SCIM_TOKEN = 'scim-mount-test-token-0123456789';

async function loadApp(scimToken: string | undefined): Promise<Express> {
  const previous = process.env.SCIM_TOKEN;
  if (scimToken === undefined) delete process.env.SCIM_TOKEN;
  else process.env.SCIM_TOKEN = scimToken;

  let app!: Express;
  try {
    await jest.isolateModulesAsync(async () => {
      app = (await import('../index')).createApp();
    });
  } finally {
    if (previous === undefined) delete process.env.SCIM_TOKEN;
    else process.env.SCIM_TOKEN = previous;
  }
  return app;
}

describe('SCIM router mounting in createApp', () => {
  it('serves /scim/v2 behind the bearer token when SCIM_TOKEN is set', async () => {
    const app = await loadApp(SCIM_TOKEN);

    const ok = await request(app)
      .get('/scim/v2/ServiceProviderConfig')
      .set('Authorization', `Bearer ${SCIM_TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.body.patch).toEqual({ supported: true });

    const denied = await request(app)
      .get('/scim/v2/ServiceProviderConfig')
      .set('Authorization', 'Bearer not-the-token');
    expect(denied.status).toBe(401);
  });

  it('does not expose /scim/v2 at all when SCIM_TOKEN is unset', async () => {
    const app = await loadApp(undefined);

    const res = await request(app)
      .get('/scim/v2/ServiceProviderConfig')
      .set('Authorization', `Bearer ${SCIM_TOKEN}`);
    expect(res.status).toBe(404);
  });
});
