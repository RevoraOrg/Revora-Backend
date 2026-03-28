# API Docs Route Security

## Overview
This feature secures the `/api-docs` endpoint to prevent unintended exposure in production environments.

## Behavior

- API docs are accessible in development and test environments
- API docs are disabled by default in production
- API docs can be enabled explicitly using `ENABLE_API_DOCS=true`
- Optional header-based protection using `API_DOCS_ACCESS_KEY`

## Security Model

| Environment | Behavior |
|------------|----------|
| development | allowed |
| test | allowed |
| production | blocked |
| production + enabled | restricted |

## Environment Variables

- NODE_ENV
- ENABLE_API_DOCS
- API_DOCS_ACCESS_KEY

## Abuse Protection

- Prevents public exposure of internal API structure
- Reduces attack surface
- Supports access-key validation

## Test Coverage

- Verified development access
- Verified production blocking
- Verified access key validation
- Verified existing routes remain unaffected