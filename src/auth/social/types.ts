import { LoginSuccessResponse, UserRole } from '../login/types';

export type SocialAuthProvider = 'google' | 'apple';

export interface SocialProviderClaims {
  provider: SocialAuthProvider;
  subject: string;
  email: string;
  emailVerified: boolean;
  issuer: string;
  audience: string;
  /** @notice Apple "Hide My Email" private-relay flag. When `true`, the email
   *          is a transient forwarding address that may change on reinstall.
   *          Account lookup must key on `subject` (sub), not email. */
  isPrivateRelay?: boolean;
}

export interface SocialTokenVerifier {
  verify(provider: SocialAuthProvider, idToken: string): Promise<SocialProviderClaims>;
}

export interface SocialIdentityRecord {
  id: string;
  userId: string;
  provider: SocialAuthProvider;
  providerSubject: string;
  providerEmail: string;
  emailVerified: boolean;
  /** @notice When `true`, the stored email is an Apple private-relay address
   *          and should only be used as a transient contact. */
  isPrivateRelay: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SocialIdentityRepository {
  findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string,
  ): Promise<SocialIdentityRecord | null>;
  findByUserAndProvider(
    userId: string,
    provider: SocialAuthProvider,
  ): Promise<SocialIdentityRecord | null>;
  createIdentity(input: {
    userId: string;
    provider: SocialAuthProvider;
    providerSubject: string;
    providerEmail: string;
    emailVerified: boolean;
    isPrivateRelay?: boolean;
  }): Promise<SocialIdentityRecord>;
  updateIdentityEmail(
    id: string,
    providerEmail: string,
    isPrivateRelay?: boolean,
  ): Promise<void>;
  deleteByUserAndProvider(userId: string, provider: SocialAuthProvider): Promise<boolean>;
}

export interface SocialUserRecord {
  id: string;
  email: string;
  role: UserRole;
  passwordHash: string;
}

export interface SocialUserRepository {
  findById(id: string): Promise<SocialUserRecord | null>;
  findByEmail(email: string): Promise<SocialUserRecord | null>;
}

export type SocialAuthErrorCode =
  | 'INVALID_PROVIDER'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'INVALID_TOKEN'
  | 'UNVERIFIED_EMAIL'
  | 'SOCIAL_IDENTITY_NOT_LINKED'
  | 'EMAIL_ACCOUNT_REQUIRES_LINK'
  | 'USER_NOT_FOUND'
  | 'STEP_UP_REQUIRED'
  | 'IDENTITY_LINKED_TO_ANOTHER_USER';

export class SocialAuthError extends Error {
  constructor(
    public readonly code: SocialAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocialAuthError';
    Object.setPrototypeOf(this, SocialAuthError.prototype);
  }
}

export interface SocialLinkResult {
  linked: true;
  identity: SocialIdentityRecord;
}

export interface SocialUnlinkResult {
  unlinked: boolean;
}

export type SocialLoginResult = LoginSuccessResponse;
