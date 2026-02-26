# Notification Preferences API

## Endpoints

### GET /api/users/me/notification-preferences
Get the authenticated user's notification preferences.

**Authentication:** Required (JWT)

**Response:**
```json
{
  "user_id": "uuid",
  "email_notifications": true,
  "push_notifications": true,
  "sms_notifications": false,
  "updated_at": "2026-02-25T20:00:00Z"
}
```

If no preferences exist, returns default values:
```json
{
  "email_notifications": true,
  "push_notifications": true,
  "sms_notifications": false
}
```

### PATCH /api/users/me/notification-preferences
Update the authenticated user's notification preferences.

**Authentication:** Required (JWT)

**Request Body:**
```json
{
  "email_notifications": false,
  "push_notifications": true,
  "sms_notifications": false
}
```

All fields are optional. Only provided fields will be updated.

**Response:**
```json
{
  "user_id": "uuid",
  "email_notifications": false,
  "push_notifications": true,
  "sms_notifications": false,
  "updated_at": "2026-02-25T20:00:00Z"
}
```

## Usage Example

To integrate this route into your Express app (with versioned API prefix):

```typescript
import express from 'express';
import { Pool } from 'pg';
import { createNotificationPreferencesRouter } from './routes/notificationPreferences';
import { NotificationPreferencesRepository } from './db/repositories/notificationPreferencesRepository';

const db = new Pool({ /* your config */ });
const notificationPreferencesRepository = new NotificationPreferencesRepository(db);

const app = express();

// All API routes are mounted under a versioned prefix.
const API_VERSION_PREFIX = process.env.API_VERSION_PREFIX ?? '/api/v1';
const apiRouter = express.Router();
app.use(API_VERSION_PREFIX, apiRouter);

const router = createNotificationPreferencesRouter({
  requireAuth: yourAuthMiddleware,
  notificationPreferencesRepository,
});

// Mount the feature router under the versioned API router
apiRouter.use(router);
```

## Database Migration

Run the migration to create the notification_preferences table:

```sql
-- See src/db/migrations/002_create_notification_preferences.sql
```
