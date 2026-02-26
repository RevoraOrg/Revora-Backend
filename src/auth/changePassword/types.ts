import { Request } from 'express';

/**
 * Request body for POST /api/users/me/change-password
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
 * Success response shape
 */
export interface ChangePasswordResponse {
  message: string;
}