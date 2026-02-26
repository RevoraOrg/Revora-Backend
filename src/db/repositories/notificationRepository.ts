import { Pool, QueryResult } from 'pg';

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  read_at: Date | null;
  created_at: Date;
}

export interface CreateNotificationInput {
  user_id: string;
  type: string;
  title: string;
  body: string;
}

export class NotificationRepository {
  constructor(private db: Pool) {}

  async create(input: CreateNotificationInput): Promise<Notification> {
    const query = `
      INSERT INTO notifications (user_id, type, title, body, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *
    `;

    const values = [input.user_id, input.type, input.title, input.body];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create notification');
    return this.mapNotification(result.rows[0]);
  }

  async listByUser(userId: string): Promise<Notification[]> {
    const query = `
      SELECT * FROM notifications 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    const result: QueryResult = await this.db.query(query, [userId]);
    return result.rows.map((row) => this.mapNotification(row));
  }

  async markRead(notificationId: string): Promise<Notification> {
    const query = `
      UPDATE notifications 
      SET read_at = NOW() 
      WHERE id = $1 
      RETURNING *
    `;
    const result: QueryResult = await this.db.query(query, [notificationId]);
    if (result.rows.length === 0) throw new Error('Notification not found');
    return this.mapNotification(result.rows[0]);
  }

  private mapNotification(row: any): Notification {
    return {
      id: row.id,
      user_id: row.user_id,
      type: row.type,
      title: row.title,
      body: row.body,
      read_at: row.read_at,
      created_at: row.created_at,
    };
  }
}
