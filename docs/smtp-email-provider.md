# SMTP Email Provider for Transactional Email

## Overview

Previously, `src/services/emailService.ts` fell back to a `console.log` mock
provider whenever `SENDGRID_API_KEY` was missing. A self-hosted operator running
the password-reset flow without SendGrid would therefore silently print the
reset link (including the one-time reset token) to stdout.

This change adds an SMTP-backed provider that delivers password-reset and other
transactional emails over a customer-controlled SMTP relay, and makes provider
selection explicit and fail-closed.

## Provider Selection

The active provider is chosen from the `EMAIL_PROVIDER` environment variable:

| `EMAIL_PROVIDER` | Provider                       | Notes                                                            |
|------------------|--------------------------------|------------------------------------------------------------------|
| `smtp`           | `SmtpEmailProvider`            | Delivers over the configured SMTP relay via STARTTLS.            |
| `sendgrid`       | `SendGridEmailProvider`        | Requires `SENDGRID_API_KEY`.                                     |
| `mock`           | `MockEmailProvider`            | **Development/test only.** Logs recipient + subject, never body. |

Rules enforced by `createEmailService`:

- An unknown `EMAIL_PROVIDER` value throws (`sendgrid | smtp | mock` only).
- `EMAIL_PROVIDER=mock` in any environment other than `development`/`test`
  throws at construction time.
- When `EMAIL_PROVIDER` is unset, the default is `sendgrid` if
  `SENDGRID_API_KEY` is present, otherwise `mock` — and since `mock` is refused
  outside development/test, **production fails closed** (no silent fallback).
- Selecting `smtp` without `SMTP_HOST` throws; selecting `sendgrid` without a
  key throws.

## Configuration

| Variable          | Required | Default              | Description                                           |
|-------------------|----------|----------------------|-------------------------------------------------------|
| `EMAIL_PROVIDER`  | No       | sendgrid \| mock     | `sendgrid`, `smtp`, or `mock`.                        |
| `SMTP_HOST`       | smtp     | —                    | SMTP relay hostname or IP.                            |
| `SMTP_PORT`       | No       | `587`                | SMTP relay port. Must be a valid TCP port (1–65535).  |
| `SMTP_USER`       | No       | —                    | SMTP username. Must be paired with `SMTP_PASS`.       |
| `SMTP_PASS`       | No       | —                    | SMTP password. Must be paired with `SMTP_USER`.       |
| `FROM_EMAIL`      | No       | `noreply@revora.com` | Default sender address for transactional email.       |

Example `.env`:

```dotenv
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.customer-relay.example
SMTP_PORT=587
SMTP_USER=mailer@example.com
SMTP_PASS=********
FROM_EMAIL=no-reply@example.com
```

## Security Model

`SmtpEmailProvider` (in `src/services/emailService.ts`) implements
`EmailProvider` and enforces the following assumptions:

### 1. STARTTLS is mandatory before credentials or content

The session always proceeds as:

```
220 <greeting>          → EHLO → STARTTLS → <TLS handshake> → EHLO → AUTH PLAIN → MAIL FROM → RCPT TO → DATA → <message> → QUIT
```

- Credentials (`AUTH PLAIN`) and message bodies are only ever written **after**
  the STARTTLS handshake completes.
- If the relay rejects `STARTTLS` (any status other than `220`), the send fails
  closed — no fallback to plaintext, no credentials or content transmitted.
- If the relay drops the connection mid-session, the caller receives a clear
  `SMTP connection closed` error.

### 2. Plaintext authentication is rejected off-loopback

The constructor validates:

- `SMTP_HOST` is required.
- `SMTP_PORT` is an integer in `1..65535`.
- `SMTP_USER` and `SMTP_PASS` are provided together (never one without the
  other).
- If authentication is configured **and** `requireStartTls` is explicitly
  disabled, the host must be loopback (`localhost`, `127.0.0.0/8`, `::1`,
  `[::1]`, `0:0:0:0:0:0:0:1`). Otherwise construction throws:
  `SMTP plaintext authentication is only permitted for loopback hosts`.

The default (`requireStartTls: true`) means credentials are never sent without
STARTTLS — the loopback exception exists only for local test relays.

### 3. No message bodies are ever logged

- `MockEmailProvider` logs only the recipient and subject — never the body or
  token.
- `SmtpEmailProvider` performs no logging of message content at all; the SMTP
  session code has no `console.*` calls.
- Suppressed recipients are rejected by `EmailService.sendMail` **before** any
  provider API call, minimizing exposure of the body.

### 4. SMTP command injection is prevented

- `MAIL FROM` / `RCPT TO` addresses are validated with a strict regex and
  reject CR/LF characters (`Invalid email address`).
- Subject headers are stripped of CR/LF (newlines replaced with spaces).
- Message body lines beginning with `.` are dot-stuffed per RFC 5321 to prevent
  premature message termination.
- The `EHLO` hostname is sanitized to `[a-zA-Z0-9.-]` (max 253 chars, fallback
  `localhost`) so an attacker-controlled hostname cannot inject SMTP commands.

### 5. Reset tokens never reach stdout

`passwordResetService` composes the reset link containing the raw token and
hands it to `EmailService.sendMail`. With `EMAIL_PROVIDER=smtp` (or
`sendgrid`), the token travels only to the configured relay over TLS. The mock
provider (dev/test only) prints no body, so the token is never echoed to logs
in any environment.

## Failure and Abuse Paths

| Scenario                              | Behavior                                                                |
|---------------------------------------|-------------------------------------------------------------------------|
| `EMAIL_PROVIDER=mock` in production   | Throws at startup — no silent log fallback.                             |
| `EMAIL_PROVIDER` unknown              | Throws `EMAIL_PROVIDER must be one of sendgrid, smtp, or mock`.         |
| `SMTP_HOST` missing for smtp          | Throws at startup / construction.                                       |
| `SMTP_USER` without `SMTP_PASS`       | Throws — credentials must be paired.                                    |
| Relay rejects STARTTLS                | Send fails; `startTls` is never invoked; nothing sensitive sent.        |
| Relay rejects AUTH                    | Send fails; plaintext AUTH is never retried.                            |
| Relay drops connection mid-session    | Caller receives `SMTP connection closed`.                               |
| Recipient suppressed                  | `Errors.forbidden` thrown before provider API call.                     |
| `recordSend` fails after delivery     | Error logged, delivery still succeeds (deliverability is best-effort).  |

## Tests

`src/services/emailService.test.ts` covers the provider with **61 tests** and
≥95% line/statement/branch/function coverage of `src/services/emailService.ts`
(currently 98.8% statements, 96.2% branches, 99.4% lines).

Highlights:

- **Real loopback SMTP relay integration** — spins up a real TCP server on
  `127.0.0.1` that supports STARTTLS with a self-signed fixture certificate
  (trusted only via `tls.setDefaultCACertificates` inside the test). It proves
  the production `defaultSmtpConnectionFactory` (`net.connect` + `tls.connect`)
  negotiates TLS on the wire and that `AUTH PLAIN`, credentials, and the reset
  token appear **only** in the encrypted channel.
- STARTTLS refusal fails closed (no credentials sent, no TLS attempted).
- AUTH failure is surfaced without retrying plaintext auth.
- Plaintext auth is rejected for non-loopback hosts and allowed for all
  loopback variants (`localhost`, `127.x.x.x`, `::1`, `[::1]`, IPv4-mapped).
- Address/CRLF injection, subject header injection, and dot-stuffing.
- `createEmailService` provider selection incl. invalid values, missing keys,
  and mock refusal in production.
- Deliverability integration (suppression, provider-name reporting, best-effort
  `recordSend`).

Run the targeted suite:

```bash
npx jest src/services/emailService.test.ts --runInBand --coverage --collectCoverageFrom='src/services/emailService.ts' --coverageThreshold='{"global":{"statements":95,"lines":95,"functions":95,"branches":95}}'
```

Run the full suite:

```bash
npm test
```

## Verification Checklist

1. `EMAIL_PROVIDER=mock` with `NODE_ENV=production` refuses to start.
2. `EMAIL_PROVIDER=smtp` with `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`
   sends a password-reset email through the configured relay.
3. A relay that rejects `STARTTLS` causes the send to fail with no fallback.
4. `SMTP_USER` without `SMTP_PASS` (or vice versa) is rejected.
5. With `requireStartTls` disabled, a non-loopback host is rejected; loopback
   hosts are accepted.
6. The reset token never appears in application logs (mock provider prints no
   body; SMTP provider logs nothing).
7. Full `npm test` passes with the email service suite above 95% coverage.
