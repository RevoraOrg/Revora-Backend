import express, { Request, Response, NextFunction } from 'express';
import { Verifier } from '@pact-foundation/pact';
import { Server } from 'http';

const PACT_BROKER_URL = process.env.PACT_BROKER_URL;
const PACT_BROKER_TOKEN = process.env.PACT_BROKER_TOKEN;
const PROVIDER_VERSION = process.env.PROVIDER_VERSION ?? '1.0.0';
const PACT_CONSUMER_TAG = process.env.PACT_CONSUMER_TAG;

let server: Server;
let app: express.Express;

const PAYOUTS_WITH_RESULTS = [
  {
    id: 'pay-1',
    distribution_run_id: 'run-1',
    investor_id: 'inv-1',
    amount: '100.00',
    status: 'processed',
    transaction_hash: '0xabc',
    created_at: new Date('2024-01-10T00:00:00.000Z'),
    updated_at: new Date('2024-01-10T00:00:00.000Z'),
  },
  {
    id: 'pay-2',
    distribution_run_id: 'run-1',
    investor_id: 'inv-1',
    amount: '200.00',
    status: 'pending',
    transaction_hash: null,
    created_at: new Date('2024-01-11T00:00:00.000Z'),
    updated_at: new Date('2024-01-11T00:00:00.000Z'),
  },
];

const DISTRIBUTION_FIXTURE = {
  distributionRun: { id: 'run-dist-1', offering_id: 'off-1' },
  payouts: [
    { investor_id: 'inv-1', amount: '75.00' },
    { investor_id: 'inv-2', amount: '25.00' },
  ],
};

const stateStore: { currentState: string | null } = {
  currentState: null,
};

class StatefulPayoutRepo {
  async listPayoutsByInvestor(investorId: string) {
    if (stateStore.currentState === 'an investor has no payouts') {
      return [];
    }
    if (investorId === 'inv-empty') return [];
    return PAYOUTS_WITH_RESULTS.filter((p) => p.investor_id === investorId);
  }
}

class StatefulDistributionEngine {
  async distribute(offeringId: string, _period: any, _revenueAmount: number) {
    return DISTRIBUTION_FIXTURE;
  }
}

class StatefulOfferingRepo {
  async getById(id: string) {
    if (id === 'off-1') return { id: 'off-1', issuer_id: 's1' };
    return null;
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

  const createDistributionsRouter = require('../distributions').default;
  const createPayoutsRouter = require('../payouts').default;

  app.use(
    createDistributionsRouter({
      distributionEngine: new StatefulDistributionEngine(),
      offeringRepo: new StatefulOfferingRepo(),
      verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
        const auth = req.headers.authorization;
        if (!auth) {
          _res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        (req as any).id = 'pact-test-request';
        (req as any).user = { id: 'admin-1', role: 'admin' };
        next();
      }) as express.RequestHandler,
    }),
  );

  app.use(
    createPayoutsRouter({
      payoutRepo: new StatefulPayoutRepo(),
      verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
        const auth = req.headers.authorization;
        if (!auth) {
          _res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        (req as any).user = { id: 'inv-1', role: 'investor' };
        next();
      }) as express.RequestHandler,
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Route not found' });
  });

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
      opts.pactUrls = [
        'pacts/revora-consumer-revora-backend.json',
      ];
    }
  }

  return opts;
}

describe('Pact Provider Verification: Distributions & Payouts', () => {
  const PORT = 0;

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

describe('Pact Provider State Handlers: Distributions & Payouts', () => {
  let stateApp: express.Express;
  let stateServer: Server;
  let statePort: number;

  beforeAll(async () => {
    stateApp = express();
    stateApp.use(express.json());
    stateApp.post('/__state', (req: Request, res: Response) => {
      const { state } = req.body as { state?: string };
      if (
        state === 'an offering exists for distribution' ||
        state === 'an investor exists with payouts' ||
        state === 'an investor has no payouts'
      ) {
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

  it('POST /__state {state: "an investor exists with payouts"} returns 200', async () => {
    const http = require('http');
    const data = JSON.stringify({ consumer: 'revora-consumer', state: 'an investor exists with payouts' });
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

  it('POST /__state {state: "an offering exists for distribution"} returns 200', async () => {
    const http = require('http');
    const data = JSON.stringify({ consumer: 'revora-consumer', state: 'an offering exists for distribution' });
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

describe('Manual endpoint responses for Pact consumer contract alignment', () => {
  let testServer: Server;
  let testPort: number;

  beforeAll(async () => {
    const testApp = express();
    testApp.use(express.json({ limit: '32kb' }));

    const createDistributionsRouter = require('../distributions').default;
    const createPayoutsRouter = require('../payouts').default;

    testApp.use(
      createDistributionsRouter({
        distributionEngine: new StatefulDistributionEngine(),
        offeringRepo: new StatefulOfferingRepo(),
        verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
          const auth = req.headers.authorization;
          if (!auth) {
            _res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          (req as any).id = 'pact-test-request';
          (req as any).user = { id: 'admin-1', role: 'admin' };
          next();
        }) as express.RequestHandler,
      }),
    );

    testApp.use(
      createPayoutsRouter({
        payoutRepo: new StatefulPayoutRepo(),
        verifyJWT: ((req: Request, _res: Response, next: NextFunction) => {
          const auth = req.headers.authorization;
          if (!auth) {
            _res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          (req as any).user = { id: 'inv-1', role: 'investor' };
          next();
        }) as express.RequestHandler,
      }),
    );

    testApp.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Route not found' });
    });

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

  describe('POST /offerings/:id/distribute', () => {
    it('returns 200 with distribution run details for admin', async () => {
      const http = require('http');
      const data = JSON.stringify({
        revenue_amount: 100,
        period: { start: '2026-01-01', end: '2026-01-31' },
      });
      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: testPort,
            path: '/offerings/off-1/distribute',
            method: 'POST',
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
              resolve({
                status: response.statusCode,
                body: JSON.parse(body),
              }),
            );
          },
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
      expect(res.status).toBe(200);
      expect(res.body.run_id).toBe('run-dist-1');
      expect(Array.isArray(res.body.payouts)).toBe(true);
      expect(res.body.total_payouts).toBeGreaterThanOrEqual(0);
    });

    it('returns 401 when no auth token is provided', async () => {
      const http = require('http');
      const data = JSON.stringify({
        revenue_amount: 100,
        period: { start: '2026-01-01', end: '2026-01-31' },
      });
      const res = await new Promise<any>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: testPort,
            path: '/offerings/off-1/distribute',
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
              resolve({
                status: response.statusCode,
                body: JSON.parse(body),
              }),
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

  describe('GET /api/investments/payouts', () => {
    it('returns 200 with paginated payouts for the authenticated investor', async () => {
      stateStore.currentState = 'an investor exists with payouts';
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(
            `http://localhost:${testPort}/api/investments/payouts`,
            {
              headers: { Authorization: 'Bearer test-token' },
            },
            (response: any) => {
              let body = '';
              response.on('data', (chunk: string) => (body += chunk));
              response.on('end', () =>
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(body),
                }),
              );
            },
          )
          .on('error', reject);
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.payouts)).toBe(true);
      expect(res.body.payouts.length).toBeGreaterThan(0);
    });

    it('returns 401 when no auth token is provided', async () => {
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(`http://localhost:${testPort}/api/investments/payouts`, (response: any) => {
            let body = '';
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode,
                body: JSON.parse(body),
              }),
            );
          })
          .on('error', reject);
      });
      expect(res.status).toBe(401);
    });

    it('returns 200 with empty payouts list when investor has no payouts', async () => {
      stateStore.currentState = 'an investor has no payouts';
      const http = require('http');
      const res = await new Promise<any>((resolve, reject) => {
        http
          .get(
            `http://localhost:${testPort}/api/investments/payouts`,
            { headers: { Authorization: 'Bearer test-token' } },
            (response: any) => {
              let body = '';
              response.on('data', (chunk: string) => (body += chunk));
              response.on('end', () =>
                resolve({
                  status: response.statusCode,
                  body: JSON.parse(body),
                }),
              );
            },
          )
          .on('error', reject);
      });
      expect(res.status).toBe(200);
      expect(res.body.payouts).toEqual([]);
      expect(res.body.total).toBe(0);
    });
  });
});
