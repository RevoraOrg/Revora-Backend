import jwt from "jsonwebtoken";
import { globalLogger } from "./logger";

/**
 * JWT Configuration
 *
 * Secret: Must be set via JWT_SECRET environment variable
 * Key Rotation: Set JWT_SECRET_PREVIOUS for seamless secret rotation
 * Key IDs: Set JWT_KEY_ID and JWT_PREVIOUS_KEY_ID for kid-based key rotation
 * Algorithm: HS256 (HMAC SHA256)
 * Clock Skew: Configurable via JWT_CLOCK_TOLERANCE_SECONDS (default 30s)
 * Issuer: Optional, set via JWT_ISSUER
 * Audience: Optional, set via JWT_AUDIENCE
 *
 * Example .env entries:
 * JWT_SECRET=your-secure-secret-key-min-32-chars
 * JWT_SECRET_PREVIOUS=your-previous-secret-key-min-32-chars
 * JWT_KEY_ID=key-2024-01
 * JWT_PREVIOUS_KEY_ID=key-2023-12
 * JWT_ISSUER=revora-backend
 * JWT_AUDIENCE=revora-api
 * JWT_CLOCK_TOLERANCE_SECONDS=30
 */

// Default expiry times
export const TOKEN_EXPIRY = "1h";
export const REFRESH_TOKEN_EXPIRY = "7d";

/**
 * Interface for JWT payload
 */
export interface JwtPayload {
  sub: string; // Subject (user ID)
  sid?: string; // Session ID
  email?: string;
  iat?: number;
  exp?: number;
  nbf?: number;            // Not Before
  iss?: string;            // Issuer
  aud?: string | string[]; // Audience
  [key: string]: unknown;
}

/**
 * Interface for token generation options
 */
export interface TokenOptions {
  expiresIn?: string;
  subject: string;
  email?: string;
  /** @param issuer Value for the `iss` claim. When set, included in the signed token. */
  issuer?: string;
  /** @param audience Value for the `aud` claim. When set, included in the signed token. */
  audience?: string;
  additionalPayload?: Record<string, unknown>;
}

/**
 * Interface for a JWT key in the keyset
 */
export interface JwtKey {
  kid: string; // Key ID
  secret: string; // Secret key
}

/**
 * Get the current key ID for signing
 * Defaults to "current" if JWT_KEY_ID is not set
 */
export function getCurrentKeyId(): string {
  return process.env.JWT_KEY_ID || "current";
}

/**
 * Get the previous key ID for rotation
 * Returns undefined if JWT_PREVIOUS_KEY_ID is not set
 */
export function getPreviousKeyId(): string | undefined {
  return process.env.JWT_PREVIOUS_KEY_ID;
}

/**
 * @notice Returns the active keyset for JWT signing and verification.
 * @dev The keyset includes the current key and optionally the previous key.
 *      Each key has a kid (key ID) that is included in the JWT header.
 *      Verification uses the kid to select the correct key, enabling
 *      zero-downtime key rotation.
 * @returns Array of JwtKey objects ordered by priority (current first).
 * @throws {Error} If the current JWT_SECRET is missing or too short.
 */
export function getJwtKeyset(): JwtKey[] {
  const currentSecret = getJwtSecret();
  const currentKid = getCurrentKeyId();
  const keyset: JwtKey[] = [{ kid: currentKid, secret: currentSecret }];

  const previousSecret = process.env.JWT_SECRET_PREVIOUS;
  const previousKid = getPreviousKeyId();

  if (previousSecret && previousSecret.length >= 32 && previousKid) {
    keyset.push({ kid: previousKid, secret: previousSecret });
  }

  return keyset;
}

/**
 * @notice Get a secret from the keyset by key ID.
 * @dev Used during verification to select the correct secret based on the token's kid header.
 * @param kid The key ID to look up.
 * @returns The secret key for the given kid, or undefined if not found.
 */
export function getSecretByKid(kid: string): string | undefined {
  const keyset = getJwtKeyset();
  const key = keyset.find((k) => k.kid === kid);
  return key?.secret;
}

/**
 * @notice Options controlling which optional JWT claims are validated.
 * @dev All fields are optional. When omitted, the corresponding check is skipped.
 */
export interface ClaimValidationOptions {
  /** @param issuer Expected value of the `iss` claim. Validated only when provided. */
  issuer?: string;
  /** @param audience Expected value of the `aud` claim. Validated only when provided. */
  audience?: string;
  /**
   * @param clockToleranceSeconds Seconds of clock skew to tolerate for time-based claims.
   * Defaults to 30 seconds when not specified.
   */
  clockToleranceSeconds?: number;
}

/**
 * @notice Validates standard JWT claims beyond signature verification.
 * @dev Enforces sub presence, exp, iat, nbf, iss, and aud claims explicitly.
 *      Called by verifyToken after jsonwebtoken signature verification.
 *      Can also be called independently on a decoded payload.
 * @param payload The decoded JWT payload to validate.
 * @param options Optional configuration for issuer, audience, and clock skew.
 * @throws {Error} Descriptive error for each specific claim violation.
 */
export function validateClaims(
  payload: JwtPayload,
  options?: ClaimValidationOptions,
): void {
  const tolerance = options?.clockToleranceSeconds ?? 30;
  const now = Math.floor(Date.now() / 1000);

  // sub: must be present and a non-empty string
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    throw new Error('Token is missing required subject (sub) claim');
  }

  // exp: explicit check (jsonwebtoken already checks this; here for standalone use)
  if (payload.exp !== undefined && payload.exp < now - tolerance) {
    throw new Error('Token has expired');
  }

  // iat: issued-at must not be in the future (beyond tolerance)
  if (payload.iat !== undefined && payload.iat > now + tolerance) {
    throw new Error('Token iat claim is in the future');
  }

  // nbf: not-before — token must be valid by now (beyond tolerance)
  if (payload.nbf !== undefined && payload.nbf > now + tolerance) {
    throw new Error('Token is not yet valid (nbf claim)');
  }

  // iss: issuer — validated only when an expected issuer is configured
  if (options?.issuer !== undefined && payload.iss !== options.issuer) {
    throw new Error(`Token issuer mismatch: expected "${options.issuer}"`);
  }

  // aud: audience — validated only when an expected audience is configured
  if (options?.audience !== undefined) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(options.audience)) {
      throw new Error(`Token audience mismatch: expected "${options.audience}"`);
    }
  }
}

/**
 * Get JWT secret from environment
 * Throws error if not configured
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable is not set");
  }
  if (secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters for security");
  }
  return secret;
}

/**
 * Get JWT algorithm
 */
export function getJwtAlgorithm(): jwt.Algorithm {
  return "HS256";
}

/**
 * @notice Returns all valid JWT secrets for token verification, supporting key rotation.
 * @dev The current JWT_SECRET is always first. If JWT_SECRET_PREVIOUS is set and meets
 *      the minimum length requirement (32 chars), it is appended as a fallback.
 *      Tokens signed with the previous secret remain valid until they naturally expire,
 *      enabling seamless key rotation without forcing re-authentication.
 * @returns Array of secrets ordered by priority (current first).
 * @throws {Error} If the current JWT_SECRET is missing or too short.
 */
export function getJwtSecretsForVerification(): string[] {
  const current = getJwtSecret();
  const previous = process.env.JWT_SECRET_PREVIOUS;
  if (previous && previous.length >= 32) {
    return [current, previous];
  }
  return [current];
}

/**
 * @notice Returns default claim validation options derived from environment variables.
 * @dev Used by middleware to consistently enforce issuer, audience, and clock skew
 *      across all verification points without manual configuration at each call site.
 *      When JWT_CLOCK_TOLERANCE_SECONDS is not set or invalid, the validateClaims
 *      default of 30 seconds applies.
 * @returns ClaimValidationOptions with values from JWT_ISSUER, JWT_AUDIENCE, and
 *          JWT_CLOCK_TOLERANCE_SECONDS when set.
 */
export function getDefaultClaimValidationOptions(): ClaimValidationOptions {
  const opts: ClaimValidationOptions = {};
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;
  const tolerance = process.env.JWT_CLOCK_TOLERANCE_SECONDS;
  if (issuer) opts.issuer = issuer;
  if (audience) opts.audience = audience;
  if (tolerance) {
    const parsed = parseInt(tolerance, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      opts.clockToleranceSeconds = parsed;
    }
  }
  return opts;
}

/**
 * Issue a new JWT token
 *
 * @param options - Token generation options
 * @returns Signed JWT token string
 *
 * @example
 * const token = issueToken({
 *   subject: 'user-123',
 *   email: 'user@example.com'
 * });
 */
export function issueToken(options: TokenOptions): string {
  const keyset = getJwtKeyset();
  const currentKey = keyset[0];
  const algorithm = getJwtAlgorithm();

  // Apply additional payload first, but always force `sub` (and `email` when provided)
  // to match TokenOptions. This avoids duplicate-field ambiguity and prevents
  // jsonwebtoken from erroring when `subject` is also provided in SignOptions.
  const payload: JwtPayload = {
    ...(options.additionalPayload ?? {}),
    ...(options.email ? { email: options.email } : {}),
    sub: options.subject,
  };

  const signOptions: jwt.SignOptions = {
    algorithm,
    expiresIn: (options.expiresIn || TOKEN_EXPIRY) as jwt.SignOptions["expiresIn"],
    ...(options.issuer && { issuer: options.issuer }),
    ...(options.audience && { audience: options.audience }),
    header: { kid: currentKey.kid, alg: algorithm },
  };

  return jwt.sign(payload, currentKey.secret, signOptions);
}

/**
 * Issue a refresh token with longer expiry
 *
 * @param subject - User ID or subject identifier
 * @returns Signed refresh token
 */
export function issueRefreshToken(subject: string): string {
  return issueToken({
    subject,
    expiresIn: REFRESH_TOKEN_EXPIRY,
  });
}

/**
 * Decode JWT payload without verification
 * Note: Only use this for reading data, not for authentication
 *
 * @param token - JWT token string
 * @returns Decoded payload or null if invalid
 */
export function decodePayload(token: string): JwtPayload | null {
  try {
    const decoded = jwt.decode(token);
    return decoded as JwtPayload | null;
  } catch {
    return null;
  }
}

/**
 * @notice Verify and decode a JWT token, then validate its standard claims.
 * @dev Uses jsonwebtoken for HMAC-HS256 signature verification with kid-based
 *      key selection, then calls validateClaims for explicit per-claim enforcement
 *      including clock skew.
 *
 *      Clock skew handling: jsonwebtoken's built-in time checks (exp, nbf) are
 *      disabled so that validateClaims can enforce them with the configurable
 *      clock-skew tolerance window. This ensures tokens that are slightly expired
 *      due to clock drift between servers are not incorrectly rejected.
 *
 *      Key rotation with kid: The token header must contain a kid (key ID) that
 *      matches a key in the active keyset. Verification uses the secret associated
 *      with that kid. Tokens with missing or unknown kid are rejected. This enables
 *      zero-downtime key rotation where old keys remain valid until they expire.
 *
 * @param token JWT token string to verify.
 * @param options Optional claim validation configuration.
 * @returns Decoded and validated JwtPayload.
 * @throws {Error} If the token is invalid, expired, has missing/unknown kid, or any claim fails validation.
 */
export function verifyToken(
  token: string,
  options?: ClaimValidationOptions,
): JwtPayload {
  const algorithm = getJwtAlgorithm();

  // Decode the token header to extract kid
  let decodedHeader: jwt.JwtHeader | null = null;
  try {
    decodedHeader = jwt.decode(token, { complete: true })?.header ?? null;
  } catch (err: unknown) {
    throw new Error('Token decoding failed');
  }

  if (!decodedHeader) {
    throw new Error('Token header is missing');
  }

  const kid = decodedHeader.kid;
  if (!kid || typeof kid !== 'string') {
    globalLogger.warn('JWT verification failed: missing or invalid kid header');
    throw new Error('Token is missing required kid (key ID) header');
  }

  // Look up the secret by kid
  const secret = getSecretByKid(kid);
  if (!secret) {
    globalLogger.warn('JWT verification failed: unknown kid', { kid });
    throw new Error(`Token signed with unknown key ID: ${kid}`);
  }

  let payload: JwtPayload | null = null;

  try {
    // Disable jsonwebtoken's built-in time-based checks; validateClaims
    // handles exp, nbf, and iat with configurable clock-skew tolerance.
    payload = jwt.verify(token, secret, {
      algorithms: [algorithm],
      ignoreExpiration: true,
      ignoreNotBefore: true,
    }) as JwtPayload;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    globalLogger.warn('JWT signature verification failed', {
      kid,
      error: error.message,
    });
    throw error;
  }

  // Log key rotation usage for operational visibility
  const currentKid = getCurrentKeyId();
  if (kid !== currentKid) {
    globalLogger.info('JWT verified with previous key (key rotation in progress)', {
      kid,
      currentKid,
    });
  }

  validateClaims(payload, options);

  return payload;
}
