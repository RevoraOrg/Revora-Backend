import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { JwtIssuer, SessionRepository } from '../login/types';
import {
  SocialAuthError,
  SocialAuthProvider,
  SocialIdentityRepository,
  SocialLinkResult,
  SocialLoginResult,
  SocialTokenVerifier,
  SocialUnlinkResult,
  SocialUserRecord,
  SocialUserRepository,
} from './types';

export class SocialAuthService {
  constructor(
    private readonly userRepository: SocialUserRepository,
    private readonly identityRepository: SocialIdentityRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly jwtIssuer: JwtIssuer,
    private readonly tokenVerifier: SocialTokenVerifier,
  ) {}

  async loginWithProvider(
    provider: SocialAuthProvider,
    idToken: string,
  ): Promise<SocialLoginResult> {
    const claims = await this.verifyVerifiedEmail(provider, idToken);
    const identity = await this.identityRepository.findByProviderSubject(provider, claims.subject);

    if (!identity) {
      const emailUser = await this.userRepository.findByEmail(claims.email);
      if (emailUser) {
        throw new SocialAuthError(
          'EMAIL_ACCOUNT_REQUIRES_LINK',
          'A password account with this email exists. Sign in and link the provider first.',
        );
      }
      throw new SocialAuthError('SOCIAL_IDENTITY_NOT_LINKED', 'Social identity is not linked.');
    }

    const user = await this.userRepository.findById(identity.userId);
    if (!user) {
      throw new SocialAuthError('USER_NOT_FOUND', 'Linked user was not found.');
    }

    if (identity.providerEmail !== claims.email) {
      await this.identityRepository.updateIdentityEmail(identity.id, claims.email);
    }

    return this.issueSession(user);
  }

  async linkProvider(input: {
    userId: string;
    provider: SocialAuthProvider;
    idToken: string;
    currentPassword: string;
  }): Promise<SocialLinkResult> {
    const user = await this.requireUserWithPassword(input.userId, input.currentPassword);
    const claims = await this.verifyVerifiedEmail(input.provider, input.idToken);

    const existingProviderSubject = await this.identityRepository.findByProviderSubject(
      input.provider,
      claims.subject,
    );
    if (existingProviderSubject && existingProviderSubject.userId !== input.userId) {
      throw new SocialAuthError(
        'IDENTITY_LINKED_TO_ANOTHER_USER',
        'Social identity is already linked to another account.',
      );
    }

    const existingUserProvider = await this.identityRepository.findByUserAndProvider(
      input.userId,
      input.provider,
    );

    if (existingUserProvider) {
      if (existingUserProvider.providerSubject !== claims.subject) {
        throw new SocialAuthError(
          'IDENTITY_LINKED_TO_ANOTHER_USER',
          'This account already has a different identity for the provider.',
        );
      }
      if (existingUserProvider.providerEmail !== claims.email) {
        await this.identityRepository.updateIdentityEmail(existingUserProvider.id, claims.email);
      }
      return { linked: true, identity: existingUserProvider };
    }

    if (user.email !== claims.email) {
      const emailUser = await this.userRepository.findByEmail(claims.email);
      if (emailUser && emailUser.id !== input.userId) {
        throw new SocialAuthError(
          'EMAIL_ACCOUNT_REQUIRES_LINK',
          'Provider email belongs to another password account.',
        );
      }
    }

    const identity = await this.identityRepository.createIdentity({
      userId: input.userId,
      provider: input.provider,
      providerSubject: claims.subject,
      providerEmail: claims.email,
      emailVerified: claims.emailVerified,
    });

    return { linked: true, identity };
  }

  async unlinkProvider(input: {
    userId: string;
    provider: SocialAuthProvider;
    currentPassword: string;
  }): Promise<SocialUnlinkResult> {
    await this.requireUserWithPassword(input.userId, input.currentPassword);
    const unlinked = await this.identityRepository.deleteByUserAndProvider(
      input.userId,
      input.provider,
    );
    return { unlinked };
  }

  private async verifyVerifiedEmail(provider: SocialAuthProvider, idToken: string) {
    const claims = await this.tokenVerifier.verify(provider, idToken);
    if (!claims.emailVerified) {
      throw new SocialAuthError(
        'UNVERIFIED_EMAIL',
        'Provider email must be verified before it can be used.',
      );
    }
    return claims;
  }

  private async requireUserWithPassword(
    userId: string,
    currentPassword: string,
  ): Promise<SocialUserRecord> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new SocialAuthError('USER_NOT_FOUND', 'User was not found.');
    }
    if (!currentPassword || !this.verifyPassword(currentPassword, user.passwordHash)) {
      throw new SocialAuthError('STEP_UP_REQUIRED', 'Current password confirmation is required.');
    }
    return user;
  }

  private async issueSession(user: SocialUserRecord): Promise<SocialLoginResult> {
    const sessionId = randomUUID();
    const tokens = this.jwtIssuer.sign({
      userId: user.id,
      sessionId,
      role: user.role,
    });
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.sessionRepository.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: createHash('sha256').update(tokens.refreshToken).digest('hex'),
      expiresAt,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }

  private verifyPassword(plaintext: string, storedHash: string): boolean {
    const candidateHash = createHash('sha256').update(plaintext).digest('hex');
    const candidate = Buffer.from(candidateHash, 'utf-8');
    const stored = Buffer.from(storedHash, 'utf-8');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  }
}
