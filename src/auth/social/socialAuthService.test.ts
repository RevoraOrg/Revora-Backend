/**
 * Tests for socialAuthService.ts
 *
 * Covers:
 *   - constantTimeLookup: minimum latency floor, pass-through of result and errors,
 *     zero-overhead when fn is already slow
 *   - SocialAuthService.loginWithProvider: all branches including constant-time lookup path
 *   - SocialAuthService.linkProvider: step-up auth, email collision, idempotent re-link
 *   - SocialAuthService.unlinkProvider: idempotency
 *   - Edge cases: unverified email, wrong password, user not found, cross-account conflict
 */

import { createHash } from 'node:crypto';
import { JwtIssuer, SessionRepository, UserRole } from '../login/types';
import { SocialAuthService, constantTimeLookup, CONSTANT_TIME_LOOKUP_MIN_MS } from './socialAuthService';
import {
  SocialIdentityRecord,
  SocialIdentityRepository,
  SocialProviderClaims,
  SocialTokenVerifier,
  SocialUserRecord,
  SocialUserRepository,
} from './types';

const hashPassword = (plain: string): string =>
  createHash('sha256').update(plain).digest('hex');

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeUsers implements SocialUserRepository {
  private users = new Map<string, SocialUserRecord>();

  add(user: SocialUserRecord): void {
    this.users.set(user.id, user);
  }

  async findById(id: string): Promise<SocialUserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<SocialUserRecord | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }
}

class FakeIdentities implements SocialIdentityRepository {
  identities = new Map<string, SocialIdentityRecord>();

  async findByProviderSubject(
    provider: 'google' | 'apple',
    providerSubject: string,
  ): Promise<SocialIdentityRecord | null> {
    return (
      [...this.identities.values()].find(
        (identity) =>
          identity.provider === provider && identity.providerSubject === providerSubject,
      ) ?? null
    );
  }

  async findByUserAndProvider(
    userId: string,
    provider: 'google' | 'apple',
  ): Promise<SocialIdentityRecord | null> {
    return (
      [...this.identities.values()].find(
        (identity) => identity.userId === userId && identity.provider === provider,
      ) ?? null
    );
  }

  async createIdentity(input: {
    userId: string;
    provider: 'google' | 'apple';
    providerSubject: string;
    providerEmail: string;
    emailVerified: boolean;
  }): Promise<SocialIdentityRecord> {
    const identity: SocialIdentityRecord = {
      id: `identity-${this.identities.size + 1}`,
      userId: input.userId,
      provider: input.provider,
      providerSubject: input.providerSubject,
      providerEmail: input.providerEmail,
      emailVerified: input.emailVerified,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.identities.set(identity.id, identity);
    return identity;
  }

  async updateIdentityEmail(id: string, providerEmail: string): Promise<void> {
    const identity = this.identities.get(id);
    if (identity) {
      identity.providerEmail = providerEmail;
      identity.emailVerified = true;
      identity.updatedAt = new Date();
    }
  }

  async deleteByUserAndProvider(userId: string, provider: 'google' | 'apple'): Promise<boolean> {
    const identity = await this.findByUserAndProvider(userId, provider);
    if (!identity) return false;
    this.identities.delete(identity.id);
    return true;
  }
}

class FakeVerifier implements SocialTokenVerifier {
  claims: SocialProviderClaims = {
    provider: 'google',
    subject: 'google-subject-1',
    email: 'verified@example.com',
    emailVerified: true,
    issuer: 'https://accounts.google.com',
    audience: 'client-id',
  };

  async verify(): Promise<SocialProviderClaims> {
    return this.claims;
  }
}

class FakeSessions implements SessionRepository {
  sessions: Array<{ id: string; userId: string; tokenHash: string; expiresAt: Date }> = [];

  async createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    this.sessions.push(input);
  }
}

class FakeJwtIssuer implements JwtIssuer {
  sign(payload: { userId: string; sessionId: string; role: UserRole }) {
    return {
      accessToken: `access-${payload.userId}-${payload.sessionId}`,
      refreshToken: `refresh-${payload.userId}-${payload.sessionId}`,
    };
  }
}

function fixture() {
  const users = new FakeUsers();
  const identities = new FakeIdentities();
  const sessions = new FakeSessions();
  const verifier = new FakeVerifier();
  const service = new SocialAuthService(
    users,
    identities,
    sessions,
    new FakeJwtIssuer(),
    verifier,
  );
  return { users, identities, sessions, verifier, service };
}

// ── constantTimeLookup unit tests ────────────────────────────────────────────

describe('constantTimeLookup', () => {
  it('returns the value produced by the wrapped function', async () => {
    const result = await constantTimeLookup(async () => 'hello');
    expect(result).toBe('hello');
  });

  it('returns null from the wrapped function unchanged', async () => {
    const result = await constantTimeLookup<null>(async () => null);
    expect(result).toBeNull();
  });

  it('re-throws errors thrown by the wrapped function', async () => {
    await expect(
      constantTimeLookup(async () => {
        throw new Error('lookup failed');
      }),
    ).rejects.toThrow('lookup failed');
  });

  it('takes at least CONSTANT_TIME_LOOKUP_MIN_MS when the fn resolves instantly', async () => {
    const start = Date.now();
    await constantTimeLookup(async () => null); // resolves in ~0 ms
    const elapsed = Date.now() - start;
    // Allow 10 ms headroom for timer granularity
    expect(elapsed).toBeGreaterThanOrEqual(CONSTANT_TIME_LOOKUP_MIN_MS - 10);
  });

  it('does not add extra delay when fn already takes longer than the minimum', async () => {
    // Simulate a slow lookup that exceeds CONSTANT_TIME_LOOKUP_MIN_MS
    const slowMs = CONSTANT_TIME_LOOKUP_MIN_MS + 30;
    const start = Date.now();
    await constantTimeLookup(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), slowMs)),
    );
    const elapsed = Date.now() - start;
    // Should be close to slowMs, not slowMs + CONSTANT_TIME_LOOKUP_MIN_MS
    expect(elapsed).toBeGreaterThanOrEqual(slowMs - 5);
    expect(elapsed).toBeLessThan(slowMs + CONSTANT_TIME_LOOKUP_MIN_MS);
  });

  it('works with object return types', async () => {
    const obj = { id: 'abc', userId: 'u1' };
    const result = await constantTimeLookup(async () => obj);
    expect(result).toBe(obj);
  });

  it('works with boolean return types', async () => {
    expect(await constantTimeLookup(async () => true)).toBe(true);
    expect(await constantTimeLookup(async () => false)).toBe(false);
  });
});

// ── SocialAuthService ─────────────────────────────────────────────────────────

describe('SocialAuthService', () => {
  it('rejects unverified provider email before lookup or linking', async () => {
    const { users, verifier, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    verifier.claims = { ...verifier.claims, emailVerified: false };

    await expect(
      service.linkProvider({
        userId: 'user-1',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'Password123!',
      }),
    ).rejects.toMatchObject({ code: 'UNVERIFIED_EMAIL' });
  });

  it('does not social-login an existing password account by email without explicit link', async () => {
    const { users, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });

    await expect(service.loginWithProvider('google', 'token')).rejects.toMatchObject({
      code: 'EMAIL_ACCOUNT_REQUIRES_LINK',
    });
  });

  it('links with password step-up and then logs in through the provider', async () => {
    const { users, sessions, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });

    await service.linkProvider({
      userId: 'user-1',
      provider: 'google',
      idToken: 'token',
      currentPassword: 'Password123!',
    });
    const result = await service.loginWithProvider('google', 'token');

    expect(result.user.id).toBe('user-1');
    expect(result.accessToken).toContain('access-user-1-');
    expect(sessions.sessions).toHaveLength(1);
  });

  it('rejects link attempts without correct current password', async () => {
    const { users, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });

    await expect(
      service.linkProvider({
        userId: 'user-1',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('keeps login bound to provider subject when provider email changes', async () => {
    const { users, identities, verifier, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'old@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    await identities.createIdentity({
      userId: 'user-1',
      provider: 'google',
      providerSubject: 'google-subject-1',
      providerEmail: 'old@example.com',
      emailVerified: true,
    });
    verifier.claims = { ...verifier.claims, email: 'new@example.com', emailVerified: true };

    const result = await service.loginWithProvider('google', 'token');

    expect(result.user.id).toBe('user-1');
    expect((await identities.findByUserAndProvider('user-1', 'google'))?.providerEmail).toBe(
      'new@example.com',
    );
  });

  it('unlink is idempotent after the first successful unlink', async () => {
    const { users, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    await service.linkProvider({
      userId: 'user-1',
      provider: 'google',
      idToken: 'token',
      currentPassword: 'Password123!',
    });

    await expect(
      service.unlinkProvider({
        userId: 'user-1',
        provider: 'google',
        currentPassword: 'Password123!',
      }),
    ).resolves.toEqual({ unlinked: true });
    await expect(
      service.unlinkProvider({
        userId: 'user-1',
        provider: 'google',
        currentPassword: 'Password123!',
      }),
    ).resolves.toEqual({ unlinked: false });
  });

  it('throws USER_NOT_FOUND when login succeeds but linked user is missing from user store', async () => {
    const { identities, verifier, service } = fixture();
    // Create identity pointing to a non-existent user
    await identities.createIdentity({
      userId: 'ghost-user',
      provider: 'google',
      providerSubject: verifier.claims.subject,
      providerEmail: verifier.claims.email,
      emailVerified: true,
    });

    await expect(service.loginWithProvider('google', 'token')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('throws SOCIAL_IDENTITY_NOT_LINKED for a completely unknown social identity', async () => {
    const { service } = fixture();
    // No identity, no user with matching email either
    await expect(service.loginWithProvider('google', 'token')).rejects.toMatchObject({
      code: 'SOCIAL_IDENTITY_NOT_LINKED',
    });
  });

  it('rejects link when the social identity belongs to a different account', async () => {
    const { users, identities, verifier, service } = fixture();
    users.add({ id: 'user-1', email: 'user1@example.com', role: 'investor', passwordHash: hashPassword('Pass1!') });
    users.add({ id: 'user-2', email: 'verified@example.com', role: 'investor', passwordHash: hashPassword('Pass2!') });
    // Pre-link google-subject-1 to user-1
    await identities.createIdentity({
      userId: 'user-1',
      provider: 'google',
      providerSubject: verifier.claims.subject,
      providerEmail: 'user1@example.com',
      emailVerified: true,
    });

    // user-2 tries to link the same google identity
    await expect(
      service.linkProvider({
        userId: 'user-2',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'Pass2!',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_LINKED_TO_ANOTHER_USER' });
  });

  it('re-linking the same provider identity is idempotent and updates email if changed', async () => {
    const { users, identities, verifier, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });

    // First link
    await service.linkProvider({
      userId: 'user-1',
      provider: 'google',
      idToken: 'token',
      currentPassword: 'Password123!',
    });

    // Second link — same identity, provider email changed on the provider side
    verifier.claims = { ...verifier.claims, email: 'updated@example.com' };
    const result = await service.linkProvider({
      userId: 'user-1',
      provider: 'google',
      idToken: 'token',
      currentPassword: 'Password123!',
    });

    expect(result.linked).toBe(true);
    const stored = await identities.findByUserAndProvider('user-1', 'google');
    expect(stored?.providerEmail).toBe('updated@example.com');
  });

  it('rejects link when trying to link a different sub to a user who already has that provider', async () => {
    const { users, identities, verifier, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    // Pre-link different subject
    await identities.createIdentity({
      userId: 'user-1',
      provider: 'google',
      providerSubject: 'different-subject',
      providerEmail: 'old@example.com',
      emailVerified: true,
    });

    // Now try to link a new subject (verifier.claims.subject = 'google-subject-1')
    await expect(
      service.linkProvider({
        userId: 'user-1',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'Password123!',
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_LINKED_TO_ANOTHER_USER' });
  });

  it('rejects link when the provider email belongs to another password account', async () => {
    const { users, verifier, service } = fixture();
    // user-1 has the same email as the provider claims
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    // user-2 is trying to link; provider returns email belonging to user-1
    users.add({
      id: 'user-2',
      email: 'other@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password456!'),
    });
    verifier.claims = { ...verifier.claims, email: 'verified@example.com' };

    await expect(
      service.linkProvider({
        userId: 'user-2',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'Password456!',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_ACCOUNT_REQUIRES_LINK' });
  });

  it('throws USER_NOT_FOUND when linking for a non-existent user id', async () => {
    const { service } = fixture();
    await expect(
      service.linkProvider({
        userId: 'nonexistent',
        provider: 'google',
        idToken: 'token',
        currentPassword: 'anything',
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('throws USER_NOT_FOUND when unlinking for a non-existent user id', async () => {
    const { service } = fixture();
    await expect(
      service.unlinkProvider({
        userId: 'nonexistent',
        provider: 'google',
        currentPassword: 'anything',
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('issues a session with a refresh token hash stored in the session repository', async () => {
    const { users, identities, sessions, verifier, service } = fixture();
    users.add({
      id: 'user-1',
      email: 'verified@example.com',
      role: 'investor',
      passwordHash: hashPassword('Password123!'),
    });
    await identities.createIdentity({
      userId: 'user-1',
      provider: 'google',
      providerSubject: verifier.claims.subject,
      providerEmail: 'verified@example.com',
      emailVerified: true,
    });

    const result = await service.loginWithProvider('google', 'token');

    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].userId).toBe('user-1');
    // The stored tokenHash must be the SHA-256 hex of the refresh token
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update(result.refreshToken).digest('hex');
    expect(sessions.sessions[0].tokenHash).toBe(expectedHash);
  });
});
