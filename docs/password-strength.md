# Password Strength Policy

Revora-Backend enforces production-grade password requirements to ensure user accounts are protected against common attacks.

## Requirements

All passwords must meet the following criteria:

- **Length**: Between 12 and 128 characters.
- **Complexity**: Must contain at least one:
  - Uppercase letter (`A-Z`)
  - Lowercase letter (`a-z`)
  - Digit (`0-9`)
  - Special character (e.g., `!@#$%^&*`)
- **Common Passwords**: Must not be on the common passwords list.
- **Repeated Characters**: Must not contain more than 4 consecutive identical characters.
- **Sequential Characters**: Must not contain common sequences (e.g., `abcde`, `12345`).

## i18n Support

Validation errors are returned as structured objects containing machine-readable codes. Frontends should use these codes to display localized error messages.

### Error Codes

| Code | Description |
| :--- | :--- |
| `PASSWORD_REQUIRED` | Password field is missing or empty. |
| `PASSWORD_TOO_SHORT` | Password is less than 12 characters. |
| `PASSWORD_TOO_LONG` | Password exceeds 128 characters. |
| `PASSWORD_MISSING_UPPERCASE` | Missing uppercase letter. |
| `PASSWORD_MISSING_LOWERCASE` | Missing lowercase letter. |
| `PASSWORD_MISSING_NUMBER` | Missing digit. |
| `PASSWORD_MISSING_SPECIAL` | Missing special character. |
| `PASSWORD_TOO_COMMON` | Password is too common/guessable. |
| `PASSWORD_EXCESSIVE_REPEATED` | Too many repeated characters. |
| `PASSWORD_SEQUENTIAL_CHARACTERS` | Contains sequential characters. |

## Security and Privacy

- **No PII in Feedback**: Error messages and details never include the password or any part of it.
- **Redaction**: Passwords are automatically redacted from all structured logs.
- **Redacted Logging**: Validation failures are logged with the associated email and error codes, but the raw password is never persisted or output.

## Developer Usage

```typescript
import { validatePasswordStrength } from './lib/passwordStrength';

const result = validatePasswordStrength(password);
if (!result.isValid) {
  // result.errors contains { code, message }[]
}
```
