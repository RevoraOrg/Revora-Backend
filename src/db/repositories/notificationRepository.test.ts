import assert from 'assert';
import { NotificationRepository } from './notificationRepository';

class MockPool {
  constructor(private rows: any[] = [], private rowCount = 1) {}
  async query(_text: string, _values?: any[]) {
    return { rows: this.rows, rowCount: this.rowCount };
  }
}

describe('NotificationRepository', () => {
  it('create/listByUser/markRead behave as expected with mocked pool', async () => {
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
  const markReadRepo = new NotificationRepository(new MockPool([], 1) as any);
  const marked = await markReadRepo.markRead('n1', 'u1');
  assert(marked === true);

  // Test markReadBulk
  const markReadBulkRepo = new NotificationRepository(new MockPool([], 2) as any);
  const markedCount = await markReadBulkRepo.markReadBulk(['n1', 'n2', 'n2'], 'u1');
  assert(markedCount === 2);
  });
});
