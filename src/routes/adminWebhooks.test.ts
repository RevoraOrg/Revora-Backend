import express from 'express';
import request from 'supertest';
import { createAdminWebhooksRouter } from './adminWebhooks';

function makeRequireAuth(role = 'admin') {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).user = { id: 'user-1', role };
    next();
  };
}

describe('Admin Webhooks Router', () => {
  test('GET dead-letters returns list for admin', async () => {
    const mockRepo: any = {
      listDeadLettersByEndpoint: jest.fn().mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]),
      countDeadLettersByEndpoint: jest.fn().mockResolvedValue(2),
    };

    const app = express();
    app.use(express.json());
    app.use('/admin/webhooks', createAdminWebhooksRouter({ repo: mockRepo, requireAuth: makeRequireAuth('admin') }));

    const res = await request(app).get('/admin/webhooks/endpoint-1/dead-letters');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(mockRepo.listDeadLettersByEndpoint).toHaveBeenCalledWith('endpoint-1', 50, 0);
  });

  test('non-admin cannot access listing', async () => {
    const mockRepo: any = { listDeadLettersByEndpoint: jest.fn(), countDeadLettersByEndpoint: jest.fn() };
    const app = express();
    app.use(express.json());
    app.use('/admin/webhooks', createAdminWebhooksRouter({ repo: mockRepo, requireAuth: makeRequireAuth('investor') }));

    const res = await request(app).get('/admin/webhooks/endpoint-1/dead-letters');
    expect(res.status).toBe(403);
  });

  test('POST replay idempotently resets delivery to pending and does not create duplicates', async () => {
    const delivery = { id: 'd1', endpoint_id: 'endpoint-1', payload: { event: { id: 'ev1' } }, status: 'dead_letter' } as any;
    const mockRepo: any = {
      findDeliveryById: jest.fn().mockResolvedValue(delivery),
      updateDelivery: jest.fn().mockImplementation(async (id, updates) => ({ ...delivery, ...updates })),
      findById: jest.fn().mockResolvedValue({ id: 'endpoint-1', url: 'https://example.com' }),
      createDelivery: jest.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use('/admin/webhooks', createAdminWebhooksRouter({ repo: mockRepo, requireAuth: makeRequireAuth('admin') }));

    const res1 = await request(app).post('/admin/webhooks/dead-letters/d1/replay');
    expect(res1.status).toBe(200);
    expect(mockRepo.updateDelivery).toHaveBeenCalled();
    expect(mockRepo.createDelivery).not.toHaveBeenCalled();

    const res2 = await request(app).post('/admin/webhooks/dead-letters/d1/replay');
    expect(res2.status).toBe(200);
    // still no new create
    expect(mockRepo.createDelivery).not.toHaveBeenCalled();
  });

  test('replay returns 400 if delivery not dead_letter', async () => {
    const delivery = { id: 'd2', endpoint_id: 'endpoint-1', status: 'failed' } as any;
    const mockRepo: any = {
      findDeliveryById: jest.fn().mockResolvedValue(delivery),
    };

    const app = express();
    app.use(express.json());
    app.use('/admin/webhooks', createAdminWebhooksRouter({ repo: mockRepo, requireAuth: makeRequireAuth('admin') }));

    const res = await request(app).post('/admin/webhooks/dead-letters/d2/replay');
    expect(res.status).toBe(400);
  });
});
