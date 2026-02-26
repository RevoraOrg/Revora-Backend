import assert from 'assert';
import { NotificationRepository } from './notificationRepository';

class MockPool {
  constructor(private rows: any[] = [], private rowCount = 1) {}
  async query(_text: string, _values?: any[]) {
    return { rows: this.rows, rowCount: this.rowCount };
  }
}

(async function run() {
  const sampleNotification = {
    id: 'n1',
    user_id: 'u1',
    type: 'info',
    title: 'Test Notification',
    body: 'This is a test notification',
    read_at: null,
    created_at: new Date(),
  };

  // Test create
  const createRepo = new NotificationRepository(new MockPool([sampleNotification]) as any);
  const created = await createRepo.create({
    user_id: 'u1',
    type: 'info',
    title: 'Test Notification',
    body: 'This is a test notification',
  });
  assert(created.title === 'Test Notification');
  assert(created.user_id === 'u1');

  // Test listByUser
  const listRepo = new NotificationRepository(new MockPool([sampleNotification, { ...sampleNotification, id: 'n2' }]) as any);
  const notifications = await listRepo.listByUser('u1');
  assert(notifications.length === 2);
  assert(notifications[0].user_id === 'u1');

  // Test markRead
  const readNotification = { ...sampleNotification, read_at: new Date() };
  const markReadRepo = new NotificationRepository(new MockPool([readNotification]) as any);
  const marked = await markReadRepo.markRead('n1');
  assert(marked.read_at !== null);
  assert(marked.id === 'n1');

  console.log('notificationRepository tests passed');
})();
