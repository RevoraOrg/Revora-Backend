import assert from 'assert';
import { UserRepository } from './userRepository';

// Simple mock Pool that captures queries and returns pre-canned rows
class MockPool {
  constructor(private rows: any[] = []) {}
  async query(_text: string, _values?: any[]) {
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

(async function run() {
  // findUserByEmail
  const sampleUser = {
    id: 'u1',
    email: 'a@b.com',
    password_hash: 'hash',
    role: 'investor',
    created_at: new Date(),
  };

  const repo = new UserRepository(new MockPool([sampleUser]));
  const found = await repo.findUserByEmail('a@b.com');
  assert(found !== null, 'expected to find user by email');
  assert(found!.email === 'a@b.com');

  // createUser should return created row
  const createPool = new MockPool([sampleUser]);
  const createRepo = new UserRepository(createPool as any);
  const created = await createRepo.createUser({
    email: 'a@b.com',
    password_hash: 'hash',
    role: 'investor',
  });
  assert(created.email === 'a@b.com');

  console.log('userRepository tests passed');
})();
