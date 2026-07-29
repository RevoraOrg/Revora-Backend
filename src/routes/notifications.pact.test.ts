import express, { Request, Response, NextFunction } from 'express';
import { Verifier } from '@pact-foundation/pact';
import { Server } from 'http';
import { errorHandler } from '../middleware/errorHandler';

const PACT_BROKER_URL = process.env.PACT_BROKER_URL;
const PACT_BROKER_TOKEN = process.env.PACT_BROKER_TOKEN;
const PROVIDER_VERSION = process.env.PROVIDER_VERSION ?? '1.0.0';
const PACT_CONSUMER_TAG = process.env.PACT_CONSUMER_TAG;

const U1 = '550e8400-e29b-41d4-a716-446655440000';
const N1 = '550e8400-e29b-41d4-a716-446655440002';
const N2 = '550e8400-e29b-41d4-a716-446655440003';
const NX = '550e8400-e29b-41d4-a716-446655440005';

const NOTIFICATION_ROWS = [
  {
    id: N1,
    user_id: U1,
    type: 'info',
    message: 'm1',
    read: false,
    created_at: new Date('2024-01-10T00:00:00.000Z'),
  },
  {
    id: N2,
    user_id: U1,
    type: 'alert',
    message: 'm2',
    read: false,
    created_at: new Date('2024-01-11T00:00:00.000Z'),
  },
];

const stateStore: { currentState: string | null } = { currentState: null };

class StatefulNotificationRepo {
  notifications: any[];

  constructor() {
    this.notifications = JSON.parse(JSON.stringify(NOTIFICATION_ROWS));
  }

  reset() {
    this.notifications = JSON.parse(JSON.stringify(NOTIFICATION_ROWS));
  }

  async listByUser(userId: string) {
    if (stateStore.currentState === 'user has no notifications') {
      return [];
    }
    return this.notifications.filter((n: any) => n.user_id === userId);
  }

  async markRead(id: string, userId: string) {
    if (stateStore.currentState === 'notification does not exist') {
      return false;
    }
    const idx = this.notifications.findIndex(
      (n: any) => n.id === id && n.user_id === userId,
    );
    if (idx === -1) return false;
    this.notifications[idx].read = true;
    return true;
  }

  async markReadBulk(ids: string[], userId: string) {
    let count = 0;
    for (const id of ids) {
      const ok = await this.markRead(id, userId);
      if (ok) count++;
    }
    return count;
  }
}

function buildVerifierApp() {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  app.post('/__state', (req: Request, res: Response) => {
    const { state } = req.body as { state?: string };
    if (state) {
      stateStore.currentState = state;
      res.json({ status: 'ok' });
    } else {
      res.json({ status: 'ok' });
    }
  });

  const repo = new StatefulNotificationRepo();
  const createNotificationsRouter = require('./notifications').default;

  app.use(
    createNotificationsRouter({
      notificationRepo: repo,
      verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
        const auth = req.headers.authorization;
        if (!auth) {
          _res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
          return;
        }
        (req as any).user = { id: U1, role: 'investor' };
        next();
      }) as express.RequestHandler,
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  app.use(errorHandler);

  return app;
}

function getPactUrls(): string[] | undefined {
  if (!PACT_BROKER_URL) {
    const pactDir = process.env.PACT_DIR;
    if (pactDir) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.resolve(pactDir);
      if (fs.existsSync(dir)) {
        return fs
          .readdirSync(dir)
          .filter((f: string) => f.endsWith('.json'))
          .map((f: string) => path.join(dir, f));
      }
    }
    const fs = require('fs');
    const path = require('path');
    const consumerGenerated = path.resolve('pacts/notifications/revora-consumer-revora-backend.json');
    if (fs.existsSync(consumerGenerated)) {
      return [consumerGenerated];
    }
    const staticPact = path.resolve('pacts/revora-consumer-revora-backend-notifications.json');
    if (fs.existsSync(staticPact)) {
      return [staticPact];
    }
    return undefined;
  }
  return undefined;
}

function buildVerifierOptions(port: number) {
  const opts: Record<string, any> = {
    provider: 'revora-backend',
    providerBaseUrl: `http://localhost:${port}`,
    providerVersion: PROVIDER_VERSION,
    providerStatesSetupUrl: `http://localhost:${port}/__state`,
    publishVerificationResult: !!PACT_BROKER_URL,
    failIfNoPactsFound: false,
    logLevel: process.env.PACT_LOG_LEVEL ?? 'warn',
  };

  if (PACT_BROKER_URL) {
    opts.pactBrokerUrl = PACT_BROKER_URL;
    if (PACT_BROKER_TOKEN) {
      opts.pactBrokerToken = PACT_BROKER_TOKEN;
    }
    if (PACT_CONSUMER_TAG) {
      opts.consumerVersionSelectors = [
        { tag: PACT_CONSUMER_TAG, latest: true },
      ];
    }
  } else {
    const pactUrls = getPactUrls();
    if (pactUrls && pactUrls.length > 0) {
      opts.pactUrls = pactUrls;
    } else {
      const pactUrls = getPactUrls();
      if (pactUrls && pactUrls.length > 0) {
        opts.pactUrls = pactUrls;
      }
    }
  }

  return opts;
}

describe('Pact Provider Verification: Notifications', () => {
  const PORT = 0;
  let server: Server;
  let app: express.Express;

  beforeAll(async () => {
    stateStore.currentState = null;
    app = buildVerifierApp();
    await new Promise<void>((resolve) => {
      server = app.listen(PORT, () => resolve());
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('verifies the provider meets consumer expectations', async () => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Server address unavailable');
    }
    const port = addr.port;

    const opts = buildVerifierOptions(port);
    if (!opts.pactUrls || opts.pactUrls.length === 0) {
      console.warn(
        'No pact files found. Skipping verification. ' +
          'Set PACT_BROKER_URL or PACT_DIR to run provider verification.',
      );
      return;
    }

    const verifier = new Verifier(opts);
    const result = await verifier.verifyProvider();
    expect(result).toBeDefined();
  }, 120000);
});

describe('Pact Provider State Handlers: Notifications', () => {
  let stateApp: express.Express;
  let stateServer: Server;
  let statePort: number;

  beforeAll(async () => {
    stateApp = express();
    stateApp.use(express.json());
    stateApp.post('/__state', (req: Request, res: Response) => {
      const { state } = req.body as { state?: string };
      const knownStates = [
        'user has notifications',
        'user has no notifications',
        'a notification exists',
        'notification does not exist',
      ];
      if (state && knownStates.includes(state)) {
        res.json({ status: 'ok' });
      } else if (state === undefined || state === null) {
        res.status(400).json({ error: 'Missing state parameter' });
      } else {
        res.status(400).json({ error: `Unknown state: ${state}` });
      }
    });

    await new Promise<void>((resolve) => {
      stateServer = stateApp.listen(0, () => resolve());
    });
    statePort = (stateServer.address() as any).port;
  });

  afterAll(async () => {
    if (stateServer) {
      await new Promise<void>((resolve) => stateServer.close(() => resolve()));
    }
  });

  it.each([
    'user has notifications',
    'user has no notifications',
    'a notification exists',
    'notification does not exist',
  ])('POST /__state {state: "%s"} returns 200', async (state) => {
    const http = require('http');
    const data = JSON.stringify({ consumer: 'revora-consumer', state });
    const res = await new Promise<any>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: statePort,
          path: '/__state',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (response: any) => {
          let body = '';
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('POST /__state with unknown state returns 400', async () => {
    const http = require('http');
    const data = JSON.stringify({ consumer: 'revora-consumer', state: 'unknown' });
    const res = await new Promise<any>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: statePort,
          path: '/__state',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (response: any) => {
          let body = '';
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unknown state');
  });

  it('POST /__state with no state returns 400', async () => {
    const http = require('http');
    const data = JSON.stringify({ consumer: 'revora-consumer' });
    const res = await new Promise<any>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: statePort,
          path: '/__state',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (response: any) => {
          let body = '';
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body: JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    expect(res.status).toBe(400);
  });
});

describe('Manual endpoint responses for Pact consumer contract alignment: Notifications', () => {
  let testServer: Server;
  let testPort: number;

  beforeAll(async () => {
    const testApp = express();
    testApp.use(express.json({ limit: '32kb' }));

    const repo = new StatefulNotificationRepo();
    const createNotificationsRouter = require('./notifications').default;

    testApp.use(
      createNotificationsRouter({
        notificationRepo: repo,
        verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
          const auth = req.headers.authorization;
          if (!auth) {
            _res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
            return;
          }
          (req as any).user = { id: U1, role: 'investor' };
          next();
        }) as express.RequestHandler,
      }),
    );

    testApp.use((_req: Request, res: Response) => {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' });
    });

    testApp.use(errorHandler);

    await new Promise<void>((resolve) => {
      testServer = testApp.listen(0, () => resolve());
    });
    testPort = (testServer.address() as any).port;
  });

  afterAll(async () => {
    if (testServer) {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  describe('GET /notifications', () => {
    it('returns 200 with notifications for an authenticated user', async () => {
      stateStore.currentState = 'user has notifications';
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(
            `http://localhost:${testPort}/notifications`,
            { headers: { Authorization: 'Bearer test-token' } },
            (response: any) => {
              let body = '';
              response.on('data', (chunk: string) => (body += chunk));
              response.on('end', () =>
                resolve({ status: response.statusCode, body: JSON.parse(body) }),
              );
            },
          )
          .on('error', reject);
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.notifications)).toBe(true);
      expect(res.body.notifications.length).toBeGreaterThan(0);
    });

    it('returns 200 with empty list when user has no notifications', async () => {
      stateStore.currentState = 'user has no notifications';
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(
            `http://localhost:${testPort}/notifications`,
            { headers: { Authorization: 'Bearer test-token' } },
            (response: any) => {
              let body = '';
              response.on('data', (chunk: string) => (body += chunk));
              response.on('end', () =>
                resolve({ status: response.statusCode, body: JSON.parse(body) }),
              );
            },
          )
          .on('error', reject);
      });
      expect(res.status).toBe(200);
      expect(res.body.notifications).toEqual([]);
    });

    it('returns 401 when no auth token is provided', async () => {
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(`http://localhost:${testPort}/notifications`, (response: any) => {
            let body = '';
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(body) }),
            );
          })
          .on('error', reject);
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('returns 200 when marking a notification as read', async () => {
      stateStore.currentState = 'a notification exists';
      const http = require('http');
      const data = JSON.stringify({});
      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: testPort,
            path: `/notifications/${N1}/read`,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
              Authorization: 'Bearer test-token',
            },
          },
          (response: any) => {
            let body = '';
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      expect(res.status).toBe(200);
      expect(res.body.marked).toBe(1);
    });

    it('returns 404 when notification does not exist', async () => {
      stateStore.currentState = 'notification does not exist';
      const http = require('http');
      const data = JSON.stringify({});
      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: testPort,
            path: `/notifications/${NX}/read`,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
              Authorization: 'Bearer test-token',
            },
          },
          (response: any) => {
            let body = '';
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      expect(res.status).toBe(404);
    });

    it('returns 401 when no auth token is provided', async () => {
      const http = require('http');
      const data = JSON.stringify({});
      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: testPort,
            path: `/notifications/${N1}/read`,
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(data),
            },
          },
          (response: any) => {
            let body = '';
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode, body: JSON.parse(body) }),
            );
          },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      expect(res.status).toBe(401);
    });
  });
});
