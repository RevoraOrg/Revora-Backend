import { createHash } from 'node:crypto';
import { JwtIssuer, SessionRepository, UserRole } from '../login/types';
import { SocialAuthService } from './socialAuthService';
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
});
