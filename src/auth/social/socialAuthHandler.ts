import { NextFunction, Request, RequestHandler, Response } from 'express';
import { SocialAuthService } from './socialAuthService';
import { SocialAuthError, SocialAuthProvider } from './types';

const PROVIDERS = new Set<SocialAuthProvider>(['google', 'apple']);

function getProvider(req: Request): SocialAuthProvider {
  const provider = req.params.provider;
  if (!PROVIDERS.has(provider as SocialAuthProvider)) {
    throw new SocialAuthError('INVALID_PROVIDER', 'Unsupported social auth provider.');
  }
  return provider as SocialAuthProvider;
}

function getUserId(req: Request): string | undefined {
  return (req as any).user?.sub ?? (req as any).user?.id ?? (req as any).auth?.userId;
}

function mapError(error: SocialAuthError): { status: number; code: string; message: string } {
  switch (error.code) {
    case 'INVALID_PROVIDER':
    case 'PROVIDER_NOT_CONFIGURED':
    case 'INVALID_TOKEN':
    case 'UNVERIFIED_EMAIL':
      return { status: 400, code: error.code, message: error.message };
    case 'STEP_UP_REQUIRED':
    case 'SOCIAL_IDENTITY_NOT_LINKED':
    case 'EMAIL_ACCOUNT_REQUIRES_LINK':
      return { status: 401, code: error.code, message: error.message };
    case 'IDENTITY_LINKED_TO_ANOTHER_USER':
      return { status: 409, code: error.code, message: error.message };
    case 'USER_NOT_FOUND':
      return { status: 404, code: error.code, message: error.message };
    default:
      return { status: 400, code: error.code, message: error.message };
  }
}

function requireString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SocialAuthError('INVALID_TOKEN', `${field} is required.`);
  }
  return value;
}

function requireConfirmation(body: unknown): void {
  if ((body as Record<string, unknown> | undefined)?.confirm !== true) {
    throw new SocialAuthError('STEP_UP_REQUIRED', 'Link changes require confirm: true.');
  }
}

export function createSocialLoginHandler(service: SocialAuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await service.loginWithProvider(getProvider(req), requireString(req.body, 'idToken'));
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof SocialAuthError) {
        const mapped = mapError(error);
        res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        return;
      }
      next(error);
    }
  };
}

export function createSocialLinkHandler(service: SocialAuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      requireConfirmation(req.body);
      const userId = getUserId(req);
      if (!userId) throw new SocialAuthError('STEP_UP_REQUIRED', 'Authenticated user is required.');

      const result = await service.linkProvider({
        userId,
        provider: getProvider(req),
        idToken: requireString(req.body, 'idToken'),
        currentPassword: requireString(req.body, 'currentPassword'),
      });

      res.status(200).json({
        linked: result.linked,
        provider: result.identity.provider,
        providerEmail: result.identity.providerEmail,
      });
    } catch (error) {
      if (error instanceof SocialAuthError) {
        const mapped = mapError(error);
        res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        return;
      }
      next(error);
    }
  };
}

export function createSocialUnlinkHandler(service: SocialAuthService): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      requireConfirmation(req.body);
      const userId = getUserId(req);
      if (!userId) throw new SocialAuthError('STEP_UP_REQUIRED', 'Authenticated user is required.');

      const result = await service.unlinkProvider({
        userId,
        provider: getProvider(req),
        currentPassword: requireString(req.body, 'currentPassword'),
      });

      res.status(200).json(result);
    } catch (error) {
      if (error instanceof SocialAuthError) {
        const mapped = mapError(error);
        res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
        return;
      }
      next(error);
    }
  };
}
