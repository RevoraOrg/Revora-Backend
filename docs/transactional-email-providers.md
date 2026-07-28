# Transactional Email Providers

Revora sends password-reset and other transactional emails through the provider selected by `EMAIL_PROVIDER`.

## Provider selection

Set `EMAIL_PROVIDER` to one of:

- `sendgrid`: sends through the SendGrid API and requires `SENDGRID_API_KEY`.
- `smtp`: sends through a customer-controlled SMTP relay and requires `SMTP_HOST`.
- `mock`: accepts messages without delivery. This is only permitted in `development` and `test`.

If `EMAIL_PROVIDER` is omitted, the service preserves local development behavior by using SendGrid when `SENDGRID_API_KEY` is present and mock delivery otherwise. Production deployments should set `EMAIL_PROVIDER` explicitly.

## SMTP configuration

Required for SMTP:

- `EMAIL_PROVIDER=smtp`
- `SMTP_HOST=smtp.example.com`
- `SMTP_PORT=587` (defaults to `587` when omitted)
- `FROM_EMAIL=noreply@example.com`

Optional SMTP auth:

- `SMTP_USER`
- `SMTP_PASS`

`SMTP_USER` and `SMTP_PASS` must be provided together. Credentials are sent with `AUTH PLAIN` only after the relay accepts `STARTTLS` and the socket is upgraded to TLS.

## Security assumptions

- STARTTLS is required before SMTP credentials or message content are sent.
- Plaintext SMTP authentication is rejected for non-loopback hosts.
- Mock delivery is rejected outside `development` and `test`.
- Mock delivery logs only recipient and subject metadata. Message bodies are never logged, which prevents password-reset links and tokens from leaking to stdout.
- SendGrid and SMTP delivery failures are surfaced to callers as errors. Password-reset HTTP responses remain enumeration-resistant and do not expose provider details to users.

## Failure behavior

Startup/configuration errors:

- `EMAIL_PROVIDER=sendgrid` without `SENDGRID_API_KEY` fails configuration.
- `EMAIL_PROVIDER=smtp` without `SMTP_HOST` fails configuration.
- `EMAIL_PROVIDER=mock` in production fails configuration.
- Supplying only one of `SMTP_USER` or `SMTP_PASS` fails configuration.

Runtime SMTP errors:

- If the relay rejects `STARTTLS`, delivery fails before credentials or message content are sent.
- If authentication fails, the error is propagated without retrying plaintext auth.
- Invalid sender or recipient addresses are rejected before SMTP envelope commands are issued.

