# Input Sanitization Coverage

## Overview

The Input Sanitization Coverage capability ensures that all incoming request data (body, query parameters, and URL parameters) is properly cleaned and hardened before reaching business logic or database layers. This prevents common injection attacks, XSS, and data integrity issues caused by unexpected control characters or null bytes.

## Implementation Details

### Core Sanitization Logic

The sanitization logic is implemented in `src/middleware/sanitization.ts` and applies the following transformations to string values:

1.  **Null Byte Removal**: Strips `\0` characters to prevent null byte injections.
2.  **Control Character Removal**: Removes non-printable control characters (except common ones like newline/tab).
3.  **XSS Prevention**: Strips `<script>` tags and all other HTML tags.
4.  **Whitespace Normalization**: Trims leading and trailing whitespace.
5.  **Deep Sanitization**: Recursively traverses nested objects and arrays to ensure all leaf string values are sanitized.

### Global Middleware

A global middleware is registered in `src/index.ts` to apply this sanitization automatically across all routes:

```typescript
// src/index.ts
import { createSanitizationMiddleware } from './middleware/sanitization';

// ...
app.use(express.json());
app.use(createSanitizationMiddleware());
```

### Route-Specific Hardening

Individual routes, such as the startup registration route, have been hardened with explicit validation checks and NATSpec-style documentation to clarify security assumptions.

```typescript
/**
 * @dev POST /register
 * Boundary assumption: email and password must be non-empty strings.
 * Security note: Sanitization middleware cleans the inputs before this handler.
 */
router.post('/register', (req, res) => {
  // ...
});
```

## Security Assumptions

-   **No HTML Fields**: We assume that no API fields currently require raw HTML or script content. All HTML is stripped by default.
-   **No Control Characters**: We assume that control characters are not needed for any valid business inputs.
-   **Early Boundary Scrubbing**: We sanitize at the boundary (after JSON parsing) to ensure that all subsequent middleware and handlers work with clean data.

## Testing and Verification

Sanitization coverage is verified with a comprehensive test suite in `src/routes/health.test.ts`, covering:

-   Boundary conditions (empty strings, nulls, long strings).
-   Injecting null bytes and control characters.
-   XSS injection attempts (script tags, HTML tags).
-   Nested data structures (deep objects and arrays).
-   Integration with the global application pipeline.

## Future Recommendations

-   **Content Security Policy (CSP)**: Complement sanitization with robust CSP headers if this backend ever serves browser content directly.
-   **Strict Schema Validation**: Standardize all routes to use Zod schemas in conjunction with the sanitization layer for even tighter type safety.
