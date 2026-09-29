import request from 'supertest';
import express from 'express';
import { createRegisterRouter } from './registerRoute';
import { IUserRepository, RegisteredUser } from './types';
import { errorHandler } from '../../middleware/errorHandler';

describe('RegisterRouter', () => {
  let app: express.Express;
  let mockUserRepo: jest.Mocked<IUserRepository>;

  beforeEach(() => {
    mockUserRepo = {
      findByEmail: jest.fn(),
      createUser: jest.fn(),
    };

    const router = createRegisterRouter({
      userRepository: mockUserRepo,
      rateLimitOptions: {
        limit: 3,
        windowMs: 60 * 1000, // 1 minute
      },
    });

    app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);
  });

  const validPayload = {
    email: 'investor@example.com',
    password: 'securePassword123',
    name: 'Investor One',
  };

  const validResponseUser: RegisteredUser = {
    id: 'user-1',
    email: 'investor@example.com',
    role: 'investor',
    created_at: new Date(),
  };

  it('registers a user successfully (success path)', async () => {
    mockUserRepo.findByEmail.mockResolvedValue(null);
    mockUserRepo.createUser.mockResolvedValue(validResponseUser);

    const res = await request(app)
      .post('/api/auth/investor/register')
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      user: {
        id: 'user-1',
        email: 'investor@example.com',
        role: 'investor',
      },
    });
    expect(mockUserRepo.findByEmail).toHaveBeenCalledWith(validPayload.email);
    expect(mockUserRepo.createUser).toHaveBeenCalled();
  });

  it('returns 400 on invalid input (validation failure path)', async () => {
    const res = await request(app)
      .post('/api/auth/investor/register')
      .send({ email: 'not-an-email', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('returns 409 if email already exists (domain failure path)', async () => {
    mockUserRepo.findByEmail.mockResolvedValue({ id: 'existing-user' });

    const res = await request(app)
      .post('/api/auth/investor/register')
      .send(validPayload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('enforces rate limiting on primary state transitions', async () => {
    mockUserRepo.findByEmail.mockResolvedValue(null);
    mockUserRepo.createUser.mockResolvedValue(validResponseUser);

    // The limit is 3, make 3 requests that succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/investor/register')
        .send(validPayload);
      expect(res.status).toBe(201);
    }

    // 4th request should be rate-limited (429)
    const resRateLimited = await request(app)
      .post('/api/auth/investor/register')
      .send(validPayload);

    expect(resRateLimited.status).toBe(429);
    expect(resRateLimited.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
