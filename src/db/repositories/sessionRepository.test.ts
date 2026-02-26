import assert from 'assert';
import { SessionRepository } from './sessionRepository';

class MockPool {
  constructor(private rows: any[] = [], private rowCount = 1) {}
  async query(_text: string, _values?: any[]) {
    return { rows: this.rows, rowCount: this.rowCount };
  }
}

(async function run() {
  const sample = {
    id: 's1',
    user_id: 'u1',
    token_ref: 'tkn',
    expires_at: new Date(Date.now() + 3600000),
    created_at: new Date(),
  };

  const repo = new SessionRepository(new MockPool([sample]));
  const found = await repo.findSessionByToken('tkn');
  assert(found !== null && found!.token_ref === 'tkn');

  const createRepo = new SessionRepository(new MockPool([sample]));
  const created = await createRepo.createSession({
    user_id: 'u1',
    token_ref: 'tkn',
    expires_at: sample.expires_at,
  });
  assert(created.token_ref === 'tkn');

  const delRepo = new SessionRepository(new MockPool([], 1));
  const deleted = await delRepo.deleteSessionByToken('tkn');
  assert(deleted === true);

  console.log('sessionRepository tests passed');
})();
