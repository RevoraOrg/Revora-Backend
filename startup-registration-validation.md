# Startup Registration Validation (#134)

## Overview
This document outlines the validation logic implemented for the Startup Registration endpoint. The goal is to ensure data integrity, prevent malicious injections, and provide clear feedback to clients.

## Implementation Details
The validation is handled using the **Zod** library within `src/index.ts`. This ensures type safety and runtime validation in a single schema.

### Security Assumptions & Hardening
- **Whitelisting:** We use `.strict()` on the Zod schema. This prevents "Mass Assignment" attacks by rejecting any fields not explicitly defined in the schema.
- **Input Constraints:**
    - `startupName`: Min 3, Max 100 characters to prevent database bloat and buffer issues.
    - `registrationId`: Strict alphanumeric regex (`/^[a-zA-Z0-9-]+$/`) to prevent SQL/NoSQL injection.
    - `contactEmail`: Validated via RFC-compliant email regex and forced to `.toLowerCase()` for consistency.
- **Sanitization:** All string inputs are `.trim()`ed to remove leading/trailing whitespace.

## API Specification
**Endpoint:** `POST /api/v1/startups/register`  
**Auth:** Requires `x-user-id` and `x-user-role` headers.

### Success Response (201)
```json
{
  "status": "success",
  "message": "Startup registration validated",
  "data": { ... }
}

{
  "status": "error",
  "message": "Validation Failed",
  "details": [
    { "path": "contactEmail", "message": "Invalid email format" }
  ]
}