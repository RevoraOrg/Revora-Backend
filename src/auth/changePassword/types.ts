import { Request } from 'express';

/**
 * Request body for POST /me/change-password (alias: PATCH /me/password)
 */
export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

/**
 * Auth context attached by requireAuth middleware
 * Mirrors src/auth/logout/types.ts — kept local to avoid cross-feature coupling
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  tokenId?: string;
}

/**
 * Authenticated Express request
 */
export type AuthenticatedRequest = Request & {
  auth?: AuthContext;
};

/**
 * Success response shape (HTTP 200).
 * Failure responses use the shared ErrorResponse envelope from src/lib/errors:
 *   { code, message } with statusCode 400 / 401 / 404 / 500.
 */
export interface ChangePasswordResponse {
  ok: true;
  message: string;
}