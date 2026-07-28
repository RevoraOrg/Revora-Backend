# Input Sanitization Documentation [RC26Q2-B28]

This document outlines the security measures implemented to sanitize user input, specifically focusing on XSS and SSRF prevention for offering-related fields.

## Overview

The sanitization layer is implemented in `src/lib/sanitize.ts` and utilized via middleware and direct repository integration. It ensures that any HTML-like fields (such as offering descriptions) are safe to render and do not contain malicious payloads or internal network vectors.

## Sanitization Rules

### Plain Text Fields
Fields like `name`, `symbol`, and `title` are treated as plain text. Any HTML tags found in these fields are **completely stripped**.

### HTML-Like Fields
The `description` field allows a safe subset of HTML tags for formatting:
- **Formatting**: `<b>`, `<i>`, `<em>`, `<strong>`, `<p>`, `<br>`, `h1`, `h2`, `h3`
- **Lists**: `<ul>`, `<ol>`, `<li>`
- **Links**: `<a>` (only safe public URLs allowed)
- **Images**: `<img>` (only safe public URLs allowed)

#### Prohibited Attributes
All event handlers (`onclick`, `onerror`, etc.) and dangerous attributes (`style`, `id`, `class`, etc.) are stripped. Only `href` (for `<a>`) and `src`/`alt` (for `<img>`) are preserved after validation.

## SSRF Protection

The `isSafeUrl` utility validates URLs in `<a>` and `<img>` tags to prevent SSRF attacks against internal infrastructure.

### Blocked Vectors
- **Loopback**: `127.0.0.1`, `localhost`, `[::1]`
- **Private IP Ranges**:
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
  - `169.254.0.0/16` (Link-local)
- **Protocols**: Only `http:` and `https:` are allowed. `javascript:`, `data:`, `file:`, etc., are blocked.

## Integration Points

1.  **Middleware**: `offeringSanitizeMiddleware` is applied to incoming requests in `src/index.ts`.
2.  **Repository**: `OfferingRepository` applies sanitization in `create()` and `update()` methods as a secondary defense layer.

## Auditing and Logging

Any stripped HTML tags or unsafe URLs are logged via `globalLogger` at the `WARN` level for security auditing.

```json
{
  "level": "WARN",
  "message": "Stripping disallowed HTML tag: script",
  "context": { "tag": "<script>alert(1)</script>" }
}
```
