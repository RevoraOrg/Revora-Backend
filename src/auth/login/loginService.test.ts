import { createHash } from 'node:crypto';
import { LoginService } from './loginService';
import { JwtIssuer, SessionRepository, UserRecord, UserRepository } from './types';

// ── Deterministic fakes ─────────────────────────────────────────────────

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

class InMemoryUserRepository implements UserRepository {
  constructor(private readonly users: UserRecord[]) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }
}

class RecordingSessionRepository implements SessionRepository {
  readonly created: Array<{
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }> = [];

  async createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.created.push(input);
  }
}

class FakeJwtIssuer implements JwtIssuer {
  signCalls: Array<{ userId: string; sessionId: string; role: string }> = [];

  sign(payload: { userId: string; sessionId: string; role: 'startup' | 'investor' }): {
    accessToken: string;
    refreshToken: string;
  } {
    this.signCalls.push(payload);
    return {
      accessToken: `access-${payload.sessionId}`,
      refreshToken: `refresh-${payload.sessionId}`,
    };
  }
}

function buildService(users: UserRecord[]) {
  const userRepo = new InMemoryUserRepository(users);
  const sessionRepo = new RecordingSessionRepository();
  const jwtIssuer = new FakeJwtIssuer();
  const service = new LoginService(userRepo, sessionRepo, jwtIssuer);
  return { service, sessionRepo, jwtIssuer };
}

const VALID_PASSWORD = 'correct horse battery staple';
const validUser: UserRecord = {
  id: 'user-1',
  email: 'jane@example.com',
  role: 'investor',
  passwordHash: sha256(VALID_PASSWORD),
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('LoginService failure handling', () => {
  it('returns null when no user exists for the email (empty-result path)', async () => {
    const { service, sessionRepo, jwtIssuer } = buildService([validUser]);

    const result = await service.login('missing@example.com', VALID_PASSWORD);

    expect(result).toBeNull();
    // A rejected login must not create a session or issue tokens.
    expect(sessionRepo.created).toHaveLength(0);
    expect(jwtIssuer.signCalls).toHaveLength(0);
  });

  it('returns null when the password does not match the stored hash', async () => {
    const { service, sessionRepo, jwtIssuer } = buildService([validUser]);

    const result = await service.login('jane@example.com', 'wrong-password');

    expect(result).toBeNull();
    expect(sessionRepo.created).toHaveLength(0);
    expect(jwtIssuer.signCalls).toHaveLength(0);
  });

  it('returns null when the stored hash has a different length (length guard)', async () => {
    const shortHashUser: UserRecord = {
      ...validUser,
      email: 'short@example.com',
      passwordHash: 'deadbeef',
    };
    const { service, sessionRepo } = buildService([shortHashUser]);

    const result = await service.login('short@example.com', VALID_PASSWORD);

    expect(result).toBeNull();
    expect(sessionRepo.created).toHaveLength(0);
  });

  it('returns the user subset and accepts an exact password match', async () => {
    const { service, sessionRepo, jwtIssuer } = buildService([validUser]);

    const result = await service.login('jane@example.com', VALID_PASSWORD);

    expect(result).not.toBeNull();
    expect(result?.user).toEqual({
      id: 'user-1',
      email: 'jane@example.com',
      role: 'investor',
    });
    expect(result?.accessToken).toContain('access-');
    expect(result?.refreshToken).toContain('refresh-');
    expect(jwtIssuer.signCalls).toHaveLength(1);
    expect(jwtIssuer.signCalls[0]).toMatchObject({ userId: 'user-1', role: 'investor' });
    expect(sessionRepo.created).toHaveLength(1);
  });

  it('persists the sha256 of the refresh token (never the raw token)', async () => {
    const { service, sessionRepo } = buildService([validUser]);

    const result = await service.login('jane@example.com', VALID_PASSWORD);
    const session = sessionRepo.created[0];

    expect(session.tokenHash).toBe(sha256(result!.refreshToken));
    expect(session.tokenHash).not.toBe(result!.refreshToken);
    expect(session.userId).toBe('user-1');
    expect(session.id).toBe(jwtIssuerSessionId(result!.accessToken));
  });

  it('sets the session expiry roughly seven days in the future', async () => {
    const { service, sessionRepo } = buildService([validUser]);

    await service.login('jane@example.com', VALID_PASSWORD);

    const { expiresAt } = sessionRepo.created[0];
    const daysFromNow = (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(6.99);
    expect(daysFromNow).toBeLessThan(7.01);
  });
});

/** Extract the generated session id from a fake access token. */
function jwtIssuerSessionId(accessToken: string): string {
  return accessToken.replace(/^access-/, '');
}
