import { createHash } from 'node:crypto';
import { Response, NextFunction } from 'express';
import { createLoginHandler } from './loginHandler';
import { LoginService } from './loginService';
import {
  JwtIssuer,
  SessionRepository,
  UserRecord,
  UserRepository,
  UserRole,
} from './types';

// ── Helpers ─────────────────────────────────────────────────────────────

const hashPassword = (plain: string): string =>
  createHash('sha256').update(plain).digest('hex');

// ── In-memory fakes ─────────────────────────────────────────────────────

class InMemoryUserRepository implements UserRepository {
  private users: UserRecord[] = [];

  add(user: UserRecord): void {
    this.users.push(user);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.email === email) ?? null;
  }
}

class InMemorySessionRepository implements SessionRepository {
    private sessions = new Map<string, { userId: string; tokenHash: string; expiresAt: Date }>();
    private counter = 0;

    async createSession(userId: string): Promise<string> {
        const id = `session-${++this.counter}`;
        this.sessions.set(id, { userId, tokenHash: '', expiresAt: new Date(0) });
        return id;
    }

    async setSessionMetadata(sessionId: string, tokenHash: string, expiresAt: Date): Promise<void> {
        const existing = this.sessions.get(sessionId);
        if (!existing) throw new Error('Session not found');
        this.sessions.set(sessionId, { ...existing, tokenHash, expiresAt });
    }

    getSession(sessionId: string): { userId: string; tokenHash: string; expiresAt: Date } | undefined {
        return this.sessions.get(sessionId);
    }
}

class FakeJwtIssuer implements JwtIssuer {
  lastPayload: { userId: string; sessionId: string; role: UserRole } | null =
    null;

  sign(payload: { userId: string; sessionId: string; role: UserRole }): string {
    this.lastPayload = payload;
    return `fake-jwt-for-${payload.userId}-${payload.sessionId}`;
  }
}

// ── Mock Express plumbing ───────────────────────────────────────────────

class MockResponse {
  statusCode = 200;
  payload: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    return this;
  }

  send(payload?: unknown): this {
    this.payload = payload;
    return this;
  }
}

function buildRequest(body: unknown): any {
  return { body } as any;
}

const noop: NextFunction = () => undefined;

// ── Fixture factory ─────────────────────────────────────────────────────

function createFixture() {
  const userRepo = new InMemoryUserRepository();
  const sessionRepo = new InMemorySessionRepository();
  const jwtIssuer = new FakeJwtIssuer();
  const service = new LoginService(userRepo, sessionRepo, jwtIssuer);
  const handler = createLoginHandler(service);
  return { userRepo, sessionRepo, jwtIssuer, service, handler };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('login routes', () => {
  it('successful login for startup user returns 200 with token and user', async () => {
    const { userRepo, handler, jwtIssuer } = createFixture();

    userRepo.add({
      id: 'user-1',
      email: 'founder@startup.io',
      role: 'startup',
      passwordHash: hashPassword('s3cret!'),
    });

    const req = buildRequest({
      email: 'founder@startup.io',
      password: 's3cret!',
    });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(200);

    const body = res.payload as any;
    expect(body.token).toBe('fake-jwt-for-user-1-session-1');
    expect(body.user.id).toBe('user-1');
    expect(body.user.email).toBe('founder@startup.io');
    expect(body.user.role).toBe('startup');

    // JWT payload should include session
    expect(jwtIssuer.lastPayload).not.toBeNull();
    expect(jwtIssuer.lastPayload!.userId).toBe('user-1');
    expect(jwtIssuer.lastPayload!.role).toBe('startup');
    expect(jwtIssuer.lastPayload!.sessionId).toMatch(/^session-/);
  });

  it('successful login for investor user returns 200 with token and user', async () => {
    const { userRepo, handler } = createFixture();

    userRepo.add({
      id: 'user-2',
      email: 'investor@funds.co',
      role: 'investor',
      passwordHash: hashPassword('inv3st0r!'),
    });

    const req = buildRequest({
      email: 'investor@funds.co',
      password: 'inv3st0r!',
    });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(200);

    const body = res.payload as any;
    expect(body.user.role).toBe('investor');
    expect(body.user.email).toBe('investor@funds.co');
  });

  it('login with wrong password returns 401', async () => {
    const { userRepo, handler } = createFixture();

    userRepo.add({
      id: 'user-1',
      email: 'founder@startup.io',
      role: 'startup',
      passwordHash: hashPassword('correctPassword'),
    });

    const req = buildRequest({
      email: 'founder@startup.io',
      password: 'wrongPassword',
    });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Invalid email or password' });
  });

  it('login with non-existent email returns 401', async () => {
    const { handler } = createFixture();

    const req = buildRequest({
      email: 'nobody@example.com',
      password: 'anything',
    });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'Invalid email or password' });
  });

  it('login with missing email returns 400', async () => {
    const { handler } = createFixture();

    const req = buildRequest({ password: 'something' });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(400);
    expect((res.payload as any).error).toBeTruthy();
  });

  it('login with missing password returns 400', async () => {
    const { handler } = createFixture();

    const req = buildRequest({ email: 'test@example.com' });
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(400);
    expect((res.payload as any).error).toBeTruthy();
  });

  it('login with empty body returns 400', async () => {
    const { handler } = createFixture();

    const req = buildRequest(undefined);
    const res = new MockResponse();
    await handler(req, res as unknown as Response, noop);

    expect(res.statusCode).toBe(400);
  });

  it('login creates a new session for each successful login', async () => {
    const { userRepo, sessionRepo, handler } = createFixture();

    userRepo.add({
      id: 'user-1',
      email: 'founder@startup.io',
      role: 'startup',
      passwordHash: hashPassword('s3cret!'),
    });

    // First login
    const res1 = new MockResponse();
    await handler(
      buildRequest({ email: 'founder@startup.io', password: 's3cret!' }),
      res1 as unknown as Response,
      noop,
    );
    expect(res1.statusCode).toBe(200);
    expect(sessionRepo.getSession('session-1')).toBeTruthy();

    // Second login — should get a fresh session
    const res2 = new MockResponse();
    await handler(
      buildRequest({ email: 'founder@startup.io', password: 's3cret!' }),
      res2 as unknown as Response,
      noop,
    );
    expect(res2.statusCode).toBe(200);
    expect(sessionRepo.getSession('session-2')).toBeTruthy();

    // Tokens should differ (different sessions)
    expect((res1.payload as any).token).not.toBe((res2.payload as any).token);
  });

  it('LoginService.login returns null for unknown user (unit)', async () => {
    const { service } = createFixture();

    const result = await service.login('ghost@example.com', 'anything');
    expect(result).toBeNull();
  });

  it('LoginService.login returns null for wrong password (unit)', async () => {
    const { userRepo, service } = createFixture();

    userRepo.add({
      id: 'user-1',
      email: 'test@example.com',
      role: 'investor',
      passwordHash: hashPassword('right'),
    });

    const result = await service.login('test@example.com', 'wrong');
    expect(result).toBeNull();
  });
});
