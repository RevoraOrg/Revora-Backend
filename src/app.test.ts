import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from './app';
import { UserRepository } from './db/repositories/userRepository';
import { SessionRepository } from './db/repositories/sessionRepository';

// The admin webhooks module imports index.ts, which starts a separate app.
// Keep this suite focused on createApp's login wiring and avoid that cycle.
jest.mock('./routes/adminWebhooks', () => ({
  createAdminWebhooksRouter: () => jest.requireActual('express').Router(),
}));
jest.mock('./routes/offeringSync', () => ({
  createOfferingSyncRouter: () => jest.requireActual('express').Router(),
}));

// These modules are referenced by app.ts but are absent from the current tree.
// They do not participate in login, so provide inert routers and a scheduler.
jest.mock('./routes/adminAuditLog', () => ({
  createAdminAuditLogRouter: () => jest.requireActual('express').Router(),
}), { virtual: true });
jest.mock('./jobs/auditLogPurgeScheduler', () => ({
  createAuditLogPurgeScheduler: () => ({ start: jest.fn() }),
}), { virtual: true });

describe('createApp login repository adapter', () => {
  const password = 'correct-password';
  const passwordHash = createHash('sha256').update(password).digest('hex');
  let findByEmail: jest.SpyInstance;
  let createSession: jest.SpyInstance;
  const previousJwtSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
  });

  beforeEach(() => {
    findByEmail = jest.spyOn(UserRepository.prototype, 'findByEmail');
    createSession = jest.spyOn(SessionRepository.prototype, 'createSession')
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
  });

  it('returns the existing 401 contract when the database has no user', async () => {
    findByEmail.mockResolvedValue(null);

    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'absent@example.com', password });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Invalid email or password' });
    expect(findByEmail).toHaveBeenCalledWith('absent@example.com');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('maps a found database user and creates a session for valid credentials', async () => {
    findByEmail.mockResolvedValue({
      id: 'user-1',
      email: 'founder@example.com',
      role: 'startup',
      password_hash: passwordHash,
    });

    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'founder@example.com', password });

    expect(response.status).toBe(200);
    expect(response.body.user).toEqual({
      id: 'user-1',
      email: 'founder@example.com',
      role: 'startup',
    });
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(findByEmail).toHaveBeenCalledWith('founder@example.com');
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'user-1' }));
  });

  it('returns a server error without exposing a repository failure', async () => {
    findByEmail.mockRejectedValue(new Error('private database detail'));

    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email: 'founder@example.com', password });

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('private database detail');
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each([
    { email: undefined, label: 'missing' },
    { email: '', label: 'empty' },
  ])('rejects a $label email before querying the repository', async ({ email }) => {
    const response = await request(createApp())
      .post('/api/auth/login')
      .send({ email, password });

    expect(response.status).toBe(400);
    expect(findByEmail).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
