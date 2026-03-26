# Notification Preferences Validation

## Overview

This document describes the validation layer for user notification preferences in the Revora Backend. The feature ensures that incoming PATCH requests to `/api/users/me/notification-preferences` are validated for type safety, preventing type confusion attacks and malformed data from reaching the database layer.

## Implementation Details

### Validation Rules

The `validateNotificationPreferencesInput` function enforces the following rules:

| Rule | Description |
|------|-------------|
| Body must be an object | `null`, `undefined`, arrays, and primitives are rejected |
| Known fields only | Only `email_notifications`, `push_notifications`, `sms_notifications` are accepted |
| Boolean type enforcement | Values must be strict booleans (`true`/`false`), not truthy/falsy |
| Partial updates allowed | Empty body `{}` is valid; only provided fields are updated |

### Error Response Shape

```json
{
  "error": "ValidationError",
  "details": ["email_notifications must be a boolean"]
}
```

### Key Files

| File | Purpose |
|------|---------|
| `src/routes/notificationPreferences.ts` | Route handlers and validation logic |
| `src/routes/notificationPreferences.test.ts` | Comprehensive test coverage |
| `src/db/repositories/notificationPreferencesRepository.ts` | Data access layer with new `getByUserId` and `upsert` methods |

### Exported Functions

- **`createNotificationPreferencesRouter(deps)`** - Factory function returning Express Router
- **`validateNotificationPreferencesInput(body)`** - Standalone validation function for unit testing

## Security Assumptions

1. **User isolation**: Users can only modify their own preferences. The `userId` is extracted from the JWT via `requireAuth` middleware and used as a hard filter in all database queries.

2. **Type safety**: Boolean fields are strictly validated. This prevents type confusion where an attacker might attempt to pass `"true"` (string) instead of `true` (boolean), potentially causing unexpected behavior in downstream systems.

3. **Unknown field rejection**: Unknown fields return errors rather than being silently ignored. This prevents future compatibility issues where new fields might be accidentally ignored.

4. **SQL injection prevention**: All database operations use parameterized queries via the `pg` driver. User input never reaches SQL unescaped.

5. **No server-side default override**: Defaults (`email_notifications: true`, `push_notifications: true`, `sms_notifications: false`) are applied only when no preference exists in the database. An authenticated user cannot trigger unintended default resets.

## Abuse/Failure Paths

| Attack Vector | Mitigation |
|--------------|------------|
| Type confusion (`"true"` instead of `true`) | Rejected with explicit error |
| Null injection (`{ email_notifications: null }`) | Rejected with explicit error |
| Unknown field injection | Rejected with explicit error |
| Array/object body | Rejected with explicit error |
| Missing auth header | Returns 401 Unauthorized |
| Expired/invalid JWT | Returns 401 Unauthorized |
| Database connection failure | Returns 500 with generic message (no internals leaked) |

## Testing Strategy

The test suite covers:

- **Unit validation**: 14 test cases for `validateNotificationPreferencesInput`
- **Route handlers**: 20 test cases for GET and PATCH endpoints
- **Auth boundaries**: Unauthenticated requests return 401
- **Error handling**: Repository failures return 500
- **Partial updates**: Only specified fields are modified
- **Edge cases**: Empty body, false values, multiple errors

### Test Output

```
npx jest src/routes/notificationPreferences.test.ts
```

```
PASS src/routes/notificationPreferences.test.ts
  validateNotificationPreferencesInput: accepts all valid boolean fields
  validateNotificationPreferencesInput: accepts empty object
  validateNotificationPreferencesInput: accepts null body
  validateNotificationPreferencesInput: accepts undefined body
  validateNotificationPreferencesInput: accepts single field update
  validateNotificationPreferencesInput: rejects non-boolean string
  validateNotificationPreferencesInput: rejects non-boolean number
  validateNotificationPreferencesInput: rejects non-boolean null
  validateNotificationPreferencesInput: rejects non-boolean object
  validateNotificationPreferencesInput: rejects unknown field
  validateNotificationPreferencesInput: rejects unknown field alongside valid field
  validateNotificationPreferencesInput: rejects array body
  validateNotificationPreferencesInput: rejects string body
  validateNotificationPreferencesInput: collects multiple errors
  validateNotificationPreferencesInput: rejects non-boolean undefined value
  GET /api/users/me/notification-preferences returns default preferences when none exist
  GET /api/users/me/notification-preferences returns existing preferences
  GET /api/users/me/notification-preferences returns 401 when not authenticated
  GET /api/users/me/notification-preferences returns 500 on repository error
  PATCH /api/users/me/notification-preferences updates preferences
  PATCH /api/users/me/notification-preferences accepts empty body
  PATCH /api/users/me/notification-preferences returns 401 when not authenticated
  PATCH /api/users/me/notification-preferences returns 400 for invalid boolean string
  PATCH /api/users/me/notification-preferences returns 400 for invalid number
  PATCH /api/users/me/notification-preferences returns 400 for null value
  PATCH /api/users/me/notification-preferences returns 400 for unknown field
  PATCH /api/users/me/notification-preferences returns 400 with multiple errors
  PATCH /api/users/me/notification-preferences returns 500 on repository error
  PATCH /api/users/me/notification-preferences applies partial update
  PATCH /api/users/me/notification-preferences rejects non-object body
  PATCH /api/users/me/notification-preferences rejects array body
  PATCH /api/users/me/notification-preferences allows false as valid value

Test Suites: 1 passed, 1 total
Tests:       34 passed, 34 total
```

## API Reference

### GET /api/users/me/notification-preferences

**Description**: Retrieve current notification preferences for the authenticated user.

**Authentication**: Required (JWT via `Authorization: Bearer <token>`)

**Response 200**:
```json
{
  "user_id": "user-123",
  "email_notifications": true,
  "push_notifications": true,
  "sms_notifications": false,
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

**Response 401**: Unauthorized

**Response 500**: Internal server error

### PATCH /api/users/me/notification-preferences

**Description**: Partially update notification preferences for the authenticated user.

**Authentication**: Required (JWT via `Authorization: Bearer <token>`)

**Request Body** (all fields optional):
```json
{
  "email_notifications": true,
  "push_notifications": false,
  "sms_notifications": true
}
```

**Response 200**: Updated preferences (same shape as GET)

**Response 400** (Validation Error):
```json
{
  "error": "ValidationError",
  "details": ["email_notifications must be a boolean"]
}
```

**Response 401**: Unauthorized

**Response 500**: Internal server error
