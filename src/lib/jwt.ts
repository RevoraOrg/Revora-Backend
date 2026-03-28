import jwt from "jsonwebtoken";

/**
 * JWT Configuration
 *
 * Secret: Must be set via JWT_SECRET environment variable
 * Algorithm: HS256 (HMAC SHA256)
 *
 * Example .env entry:
 * JWT_SECRET=your-secure-secret-key-min-32-chars
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
  additionalPayload?: Record<string, unknown>;
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
  const secret = getJwtSecret();
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
  };

  return jwt.sign(payload, secret, signOptions);
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
 * @dev Uses jsonwebtoken for HMAC-HS256 signature verification, then calls
 *      validateClaims for explicit per-claim enforcement.
 * @param token JWT token string to verify.
 * @param options Optional claim validation configuration.
 * @returns Decoded and validated JwtPayload.
 * @throws {Error} If the token is invalid, expired, or any claim fails validation.
 */
export function verifyToken(
  token: string,
  options?: ClaimValidationOptions,
): JwtPayload {
  const secret = getJwtSecret();
  const algorithm = getJwtAlgorithm();

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [algorithm],
    }) as JwtPayload;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TokenExpiredError') {
      throw new Error('Token has expired');
    }
    throw err;
  }

  validateClaims(payload, options);

  return payload;
}
