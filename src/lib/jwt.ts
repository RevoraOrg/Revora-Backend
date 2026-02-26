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
  email?: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Interface for token generation options
 */
export interface TokenOptions {
  expiresIn?: string;
  subject: string;
  additionalPayload?: Record<string, unknown>;
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

  const payload: JwtPayload = {
    sub: options.subject,
    ...options.additionalPayload,
  };

  const signOptions: jwt.SignOptions = {
    algorithm,
    expiresIn: options.expiresIn || TOKEN_EXPIRY,
    subject: options.subject,
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
 * Verify and decode a JWT token
 *
 * @param token - JWT token string
 * @returns Decoded payload if valid
 * @throws Error if token is invalid or expired
 */
export function verifyToken(token: string): JwtPayload {
  const secret = getJwtSecret();
  const algorithm = getJwtAlgorithm();

  const payload = jwt.verify(token, secret, {
    algorithms: [algorithm],
  }) as JwtPayload;

  return payload;
}
