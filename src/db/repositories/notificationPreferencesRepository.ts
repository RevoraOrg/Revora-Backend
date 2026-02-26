import { Pool, QueryResult } from 'pg';

export interface NotificationPreferences {
  user_id: string;
  email_notifications: boolean;
  push_notifications: boolean;
  sms_notifications: boolean;
  updated_at: Date;
}

export interface UpdateNotificationPreferencesInput {
  email_notifications?: boolean;
  push_notifications?: boolean;
  sms_notifications?: boolean;
}

export class NotificationPreferencesRepository {
  constructor(private db: Pool) {}

  async getByUserId(userId: string): Promise<NotificationPreferences | null> {
    const query = `
      SELECT * FROM notification_preferences
      WHERE user_id = $1
    `;
    const result: QueryResult<NotificationPreferences> = await this.db.query(query, [userId]);
    return result.rows[0] || null;
  }

  async upsert(userId: string, input: UpdateNotificationPreferencesInput): Promise<NotificationPreferences> {
    const query = `
      INSERT INTO notification_preferences (user_id, email_notifications, push_notifications, sms_notifications, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        email_notifications = COALESCE($2, notification_preferences.email_notifications),
        push_notifications = COALESCE($3, notification_preferences.push_notifications),
        sms_notifications = COALESCE($4, notification_preferences.sms_notifications),
        updated_at = NOW()
      RETURNING *
    `;
    const values = [
      userId,
      input.email_notifications,
      input.push_notifications,
      input.sms_notifications,
    ];
    const result: QueryResult<NotificationPreferences> = await this.db.query(query, values);
    if (result.rows.length === 0) {
      throw new Error('Failed to update notification preferences');
    }
    return result.rows[0];
  }
}
