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

/**
 * Notification preferences are stored as a single row per user (`user_id` PRIMARY KEY).
 *
 * Note: this matches `src/db/migrations/002_create_notification_preferences.sql`.
 */
export class NotificationPreferencesRepository {
  constructor(private db: Pool) {}

  async getByUserId(userId: string): Promise<NotificationPreferences | null> {
    const query = `
      SELECT user_id, email_notifications, push_notifications, sms_notifications, updated_at
      FROM notification_preferences
      WHERE user_id = $1
      LIMIT 1
    `;
    const result: QueryResult<NotificationPreferences> = await this.db.query(query, [
      userId,
    ]);
    return result.rows[0] ?? null;
  }

  async upsert(
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<NotificationPreferences> {
    const query = `
      INSERT INTO notification_preferences (
        user_id,
        email_notifications,
        push_notifications,
        sms_notifications,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        email_notifications = COALESCE(EXCLUDED.email_notifications, notification_preferences.email_notifications),
        push_notifications = COALESCE(EXCLUDED.push_notifications, notification_preferences.push_notifications),
        sms_notifications = COALESCE(EXCLUDED.sms_notifications, notification_preferences.sms_notifications),
        updated_at = NOW()
      RETURNING user_id, email_notifications, push_notifications, sms_notifications, updated_at
    `;

    const existing = await this.getByUserId(userId);

    const email = input.email_notifications ?? existing?.email_notifications ?? true;
    const push = input.push_notifications ?? existing?.push_notifications ?? true;
    const sms = input.sms_notifications ?? existing?.sms_notifications ?? false;

    const result: QueryResult<NotificationPreferences> = await this.db.query(query, [
      userId,
      email,
      push,
      sms,
    ]);

    if (result.rows.length === 0) {
      throw new Error('Failed to upsert notification preferences');
    }

    return result.rows[0];
  }
}
