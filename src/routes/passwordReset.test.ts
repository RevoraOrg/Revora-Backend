import express, { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { createPasswordResetRouter } from './passwordReset';
import { errorHandler } from '../middleware/errorHandler';

describe('Password reset routes', () => {
  let app: express.Express;
  let mockPool: any;
  let emailSender: jest.Mock<Promise<void>, [string, string, string]>;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(async () => ({ rows: [] })),
      release: jest.fn(),
    };

    mockPool = {
      query: jest.fn(),
      connect: jest.fn(async () => mockClient),
    };

    emailSender = jest.fn<Promise<void>, [string, string, string]>(async () => {});

    app = express();
    app.use(express.json());
    app.use(createPasswordResetRouter(mockPool, { emailSender, appUrl: 'http://localhost' }));
    app.use(((err, req, res, next) => errorHandler(err, req, res, next)) as ErrorRequestHandler);
  });

  it('returns 200 for an unknown email without exposing user existence', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'unknown@example.com' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'If the email exists, a password reset link has been sent',
    });
    expect(emailSender).not.toHaveBeenCalled();
  });

  it('returns 200 for invalid email format on request password reset', async () => {
    const response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'invalid-email' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'If the email exists, a password reset link has been sent',
    });
  });

  it('rate limits repeated password reset requests from the same IP', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/forgot-password')
        .send({ email: `test${i}@example.com` });
    }

    const response = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'test6@example.com' });

    expect(response.status).toBe(429);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'TOO_MANY_REQUESTS',
    }));
  });

  it('returns 400 for reset-password with unknown token', async () => {
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const response = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'f'.repeat(64), password: 'StrongPassword123!' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'BAD_REQUEST',
    }));
  });
});
