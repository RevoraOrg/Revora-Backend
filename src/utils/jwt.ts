import { createHmac, timingSafeEqual } from 'crypto';

export interface JwtPayload {
  sub: string;       // userId
  sid: string;       // sessionId
  iat: number;       // issued at (epoch seconds)
  exp: number;       // expires at (epoch seconds)
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  return Buffer.from(pad ? padded + '='.repeat(4 - pad) : padded, 'base64').toString('utf8');
}

function getCurrentKeyId(): string {
  return process.env.JWT_KEY_ID || 'current';
}

function getPreviousKeyId(): string | undefined {
  return process.env.JWT_PREVIOUS_KEY_ID;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
}

function getPreviousSecret(): string | undefined {
  const secret = process.env.JWT_SECRET_PREVIOUS;
  if (!secret || secret.length < 32) return undefined;
  return secret;
}

function getSecretByKid(kid: string): string | undefined {
  const currentKid = getCurrentKeyId();
  const previousKid = getPreviousKeyId();

  if (kid === currentKid) {
    return getSecret();
  }
  if (kid === previousKid) {
    return getPreviousSecret();
  }
  return undefined;
}

/**
 * Sign a JWT using HMAC-SHA256 with kid header. No external dependency.
 */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  expiresInSeconds = 3600
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: getCurrentKeyId() }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const signingInput = `${header}.${body}`;
  const signature = base64UrlEncode(
    createHmac('sha256', getSecret()).update(signingInput).digest()
  );

  return `${signingInput}.${signature}`;
}

/**
 * Verify and decode a JWT with kid-based key selection.
 * Returns the payload if valid, null otherwise.
 */
export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const signingInput = `${header}.${body}`;

  // Decode header to extract kid
  let headerObj: { alg?: string; typ?: string; kid?: string };
  try {
    headerObj = JSON.parse(base64UrlDecode(header));
  } catch {
    return null;
  }

  const kid = headerObj.kid;
  if (!kid || typeof kid !== 'string') {
    return null; // Missing or invalid kid
  }

  const secret = getSecretByKid(kid);
  if (!secret) {
    return null; // Unknown kid
  }

  const expectedSig = base64UrlEncode(
    createHmac('sha256', secret).update(signingInput).digest()
  );

  // Timing-safe signature comparison
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    return null;
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body)) as JwtPayload;
  } catch {
    return null;
  }

  // Check expiry
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;

  return payload;
}