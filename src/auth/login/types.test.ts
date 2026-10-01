import { USER_ROLES, UserRecord, UserRepository, UserRole, isUserRole } from './types';

class InMemoryUserRepository implements UserRepository {
  private readonly users = new Map<string, UserRecord>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.get(email) ?? null;
  }

  add(user: UserRecord): void {
    this.users.set(user.email, user);
  }

  remove(email: string): void {
    this.users.delete(email);
  }
}

describe('login types contract', () => {
  it('exposes the supported roles in a stable order', () => {
    expect(USER_ROLES).toEqual(['startup', 'investor']);
  });

  it.each(['startup', 'investor'] as const)('accepts %s as a UserRole', (role) => {
    expect(isUserRole(role)).toBe(true);
  });

  it.each([undefined, null, '', 'admin', 1, {}, [], true])('rejects invalid UserRole input: %p', (role) => {
    expect(isUserRole(role)).toBe(false);
  });

  it('models a UserRecord for each supported role', () => {
    const users: UserRecord[] = [
      { id: 'u-startup', email: 'founder@example.com', role: 'startup', passwordHash: 'hash-a' },
      { id: 'u-investor', email: 'investor@example.com', role: 'investor', passwordHash: 'hash-b' },
    ];

    expect(users.map(({ role }) => role)).toEqual(['startup', 'investor']);
    // @ts-expect-error Unsupported roles must remain rejected by the public type.
    const invalidRole: UserRole = 'admin';
    expect(invalidRole).toBe('admin');
  });

  it('implements UserRepository lookup, miss, and removal transitions', async () => {
    const repository = new InMemoryUserRepository();
    const user: UserRecord = {
      id: 'u-1',
      email: 'user@example.com',
      role: 'startup',
      passwordHash: 'password-hash',
    };

    expect(await repository.findByEmail(user.email)).toBeNull();
    repository.add(user);
    await expect(repository.findByEmail(user.email)).resolves.toEqual(user);
    repository.remove(user.email);
    await expect(repository.findByEmail(user.email)).resolves.toBeNull();
  });

  it('returns null for an unknown email and keeps entries isolated by email', async () => {
    const repository = new InMemoryUserRepository();
    const startupUser: UserRecord = {
      id: 'u-startup',
      email: 'founder@example.com',
      role: 'startup',
      passwordHash: 'hash-a',
    };
    const investorUser: UserRecord = {
      id: 'u-investor',
      email: 'investor@example.com',
      role: 'investor',
      passwordHash: 'hash-b',
    };

    repository.add(startupUser);
    repository.add(investorUser);

    await expect(repository.findByEmail('missing@example.com')).resolves.toBeNull();
    await expect(repository.findByEmail(startupUser.email)).resolves.toEqual(startupUser);
    await expect(repository.findByEmail(investorUser.email)).resolves.toEqual(investorUser);

    repository.remove(startupUser.email);
    await expect(repository.findByEmail(startupUser.email)).resolves.toBe(null);
    await expect(repository.findByEmail(investorUser.email)).resolves.toEqual(investorUser);
  });

  it('overwrites an existing record when the same email is added again', async () => {
    const repository = new InMemoryUserRepository();
    const original: UserRecord = {
      id: 'u-1',
      email: 'user@example.com',
      role: 'startup',
      passwordHash: 'hash-a',
    };
    const updated: UserRecord = {
      id: 'u-1',
      email: 'user@example.com',
      role: 'investor',
      passwordHash: 'hash-b',
    };

    repository.add(original);
    repository.add(updated);

    await expect(repository.findByEmail(original.email)).resolves.toEqual(updated);
  });

  it('removing a missing email is a no-op', async () => {
    const repository = new InMemoryUserRepository();
    const user: UserRecord = {
      id: 'u-1',
      email: 'user@example.com',
      role: 'startup',
      passwordHash: 'hash-a',
    };

    repository.add(user);
    repository.remove('missing@example.com');

    await expect(repository.findByEmail(user.email)).resolves.toEqual(user);
  });
});
