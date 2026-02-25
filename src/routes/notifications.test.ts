import assert from 'assert';
import { createNotificationHandlers } from './notifications';

// Mock notification repo
class MockNotificationRepo {
  notifications: any[] = [];
  marked: string[] = [];
  constructor(rows: any[]) {
    this.notifications = rows;
  }
  async listByUser(userId: string) {
    return this.notifications.filter((n) => n.user_id === userId);
  }
  async markRead(id: string, userId: string) {
    const idx = this.notifications.findIndex((n) => n.id === id && n.user_id === userId);
    if (idx === -1) return false;
    this.notifications[idx].read = true;
    this.marked.push(id);
    return true;
  }
  async markReadBulk(ids: string[], userId: string) {
    let count = 0;
    for (const id of ids) {
      const ok = await this.markRead(id, userId);
      if (ok) count++;
    }
    return count;
  }
}

function makeReq(user: any, params: any = {}, body: any = {}) {
  return { params, body, user } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; }
  } as any;
}

(async function run() {
  const rows = [
    { id: 'n1', user_id: 'u1', message: 'm1', read: false, type: 'info', created_at: new Date() },
    { id: 'n2', user_id: 'u1', message: 'm2', read: false, type: 'alert', created_at: new Date() },
    { id: 'n3', user_id: 'u2', message: 'm3', read: false, type: 'info', created_at: new Date() },
  ];

  const repo = new MockNotificationRepo(rows);
  const handlers = createNotificationHandlers(repo as any);

  // GET notifications
  const req1 = makeReq({ id: 'u1' });
  const res1 = makeRes();
  await handlers.getNotifications(req1, res1, (e: any) => { throw e; });
  const out1 = res1._get();
  assert(out1.statusCode === 200);
  assert(out1.jsonData.notifications.length === 2, 'expected 2 notifications for u1');

  // PATCH single
  const req2 = makeReq({ id: 'u1' }, { id: 'n1' }, {});
  const res2 = makeRes();
  await handlers.markRead(req2, res2, (e: any) => { throw e; });
  const out2 = res2._get();
  assert(out2.statusCode === 200);
  assert(out2.jsonData.marked === 1);
  assert(repo.notifications.find((n) => n.id === 'n1')!.read === true);

  // PATCH bulk
  const req3 = makeReq({ id: 'u1' }, {}, { ids: ['n2'] });
  const res3 = makeRes();
  await handlers.markRead(req3, res3, (e: any) => { throw e; });
  const out3 = res3._get();
  assert(out3.statusCode === 200);
  assert(out3.jsonData.marked === 1);

  // Unauthorized
  const req4 = makeReq(null);
  const res4 = makeRes();
  await handlers.getNotifications(req4, res4, (e: any) => { throw e; });
  const out4 = res4._get();
  assert(out4.statusCode === 401);

  console.log('notifications route tests passed');
})();
