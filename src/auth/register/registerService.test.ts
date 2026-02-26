import assert from 'assert';
import { createHash } from 'node:crypto';
import { RegisterService, DuplicateEmailError } from './registerService';
import { IUserRepository, RegisteredUser } from './types';

// ─── In-memory fake repository ───────────────────────────────────────────────

class FakeUserRepository implements IUserRepository {
  private users: Map<string, RegisteredUser & { password_hash: string }> = new Map();

  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
  }

  async createUser(input: { email: string; password_hash: string; role: 'investor' }): Promise<RegisteredUser> {
    const user: RegisteredUser & { password_hash: string } = {
      id: `user-${this.users.size + 1}`,
      email: input.email,
      role: input.role,
      password_hash: input.password_hash,
      created_at: new Date(),
    };
    this.users.set(input.email, user);
    return user;
  }

  getStoredHash(email: string): string | undefined {
    return this.users.get(email)?.password_hash;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async function run() {
  // ── Success: creates investor with hashed password ──────────────────────────
  {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const user = await svc.register('Alice@Example.COM', 'secret123');

    assert(user.id, 'user should have an id');
    assert.strictEqual(user.email, 'alice@example.com', 'email should be lowercased + trimmed');
    assert.strictEqual(user.role, 'investor', 'role must be investor');

    const expectedHash = createHash('sha256').update('secret123').digest('hex');
    assert.strictEqual(repo.getStoredHash('alice@example.com'), expectedHash, 'password must be SHA-256 hashed');
  }

  // ── Email normalisation: trim whitespace ─────────────────────────────────────
  {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const user = await svc.register('  bob@example.com  ', 'password1');
    assert.strictEqual(user.email, 'bob@example.com', 'leading/trailing spaces must be stripped');
  }

  // ── Duplicate email throws DuplicateEmailError ────────────────────────────────
  {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    await svc.register('carol@example.com', 'password1');

    let threw = false;
    try {
      await svc.register('carol@example.com', 'different-password');
    } catch (err) {
      threw = true;
      assert(err instanceof DuplicateEmailError, 'should throw DuplicateEmailError');
      assert.strictEqual((err as DuplicateEmailError).message, 'Email already registered');
    }
    assert(threw, 'should have thrown');
  }

  // ── Duplicate email is case-insensitive ───────────────────────────────────────
  {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    await svc.register('Dave@Example.com', 'password1');

    let threw = false;
    try {
      await svc.register('dave@example.com', 'password2');
    } catch (err) {
      threw = true;
      assert(err instanceof DuplicateEmailError, 'duplicate check is case-insensitive');
    }
    assert(threw, 'should have thrown on case-variant duplicate');
  }

  // ── Different users can register independently ──────────────────────────────
  {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const u1 = await svc.register('eve@example.com', 'password-eve');
    const u2 = await svc.register('frank@example.com', 'password-frank');

    assert.notStrictEqual(u1.id, u2.id, 'each user gets a unique id');
    assert.strictEqual(u1.role, 'investor');
    assert.strictEqual(u2.role, 'investor');
  }

  // ── Repository error propagates ───────────────────────────────────────────────
  {
    const failRepo: IUserRepository = {
      async findByEmail() { return null; },
      async createUser() { throw new Error('DB connection lost'); },
    };
    const svc = new RegisterService(failRepo);
    let threw = false;
    try {
      await svc.register('grace@example.com', 'password1');
    } catch (err) {
      threw = true;
      assert(err instanceof Error && err.message === 'DB connection lost');
    }
    assert(threw, 'DB error should propagate');
  }

  console.log('registerService tests passed');
})();
