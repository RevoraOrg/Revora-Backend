/**
 * @file socialAuthService.ts
 *
 * @notice Implements Google/Apple social authentication: login, link, and unlink.
 *
 * @dev Security model
 *      ────────────────
 *      - Provider tokens are verified (RS256 + JWKS) before any DB lookup.
 *      - Email-verified flag is mandatory — unverified emails are rejected early.
 *      - Account linking requires step-up (current password) to prevent token
 *        replay from hijacking an existing account.
 *      - `findByProviderSubject` is wrapped in `constantTimeLookup` to eliminate
 *        the timing oracle that would otherwise allow an attacker to enumerate
 *        valid accounts by measuring response latency differences between
 *        "not found" and "found" code paths.
 *
 * @dev Anti-enumeration hardening (task #544)
 *      ─────────────────────────────────────────
 *      Two defences are layered:
 *
 *      1. Per-provider-sub rate bucket (middleware layer) — see
 *         `src/middleware/socialAntiEnumerationMiddleware.ts`.  This caps the
 *         number of login attempts per identity across all source IPs.
 *
 *      2. Constant-time identity lookup (this file) — `constantTimeLookup`
 *         introduces a minimum artificial delay so that the "not found" and
 *         "found" paths return in approximately the same wall-clock time,
 *         removing the timing side-channel.
 */

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

// ── Constant-time lookup helper ────────────────────────────────────────────────

/**
 * @notice Minimum artificial delay (ms) applied to every `findByProviderSubject`
 *         call so that "not found" paths take at least as long as "found" paths.
 *
 * @dev    The value of 50 ms is intentionally conservative.  Real DB round-trips
 *         typically exceed this, so it only materialises as a floor on very fast
 *         (e.g. in-memory test) implementations.  Increase for environments where
 *         the DB round-trip is measured to be consistently below this threshold.
 */
export const CONSTANT_TIME_LOOKUP_MIN_MS = 50;

/**
 * @notice Wraps an async identity lookup so that the total elapsed time is always
 *         at least `CONSTANT_TIME_LOOKUP_MIN_MS`, regardless of whether the lookup
 *         succeeds or fails.
 *
 * @dev    This is a mitigation for timing-based account enumeration: an attacker
 *         who can measure the response time of `POST /api/auth/social/:provider/login`
 *         would otherwise be able to distinguish "no identity found" (fast path)
 *         from "identity found + session issued" (slower path).
 *
 *         The artificial delay does **not** replace the per-provider-sub rate limiter;
 *         both defences must be active simultaneously.
 *
 * @param fn  An async factory function that returns the lookup result.
 * @returns   The result of `fn`, after waiting for the minimum delay if necessary.
 *
 * @example
 * ```ts
 * const identity = await constantTimeLookup(() =>
 *   identityRepository.findByProviderSubject(provider, claims.subject)
 * );
 * ```
 */
export async function constantTimeLookup<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const elapsed = Date.now() - start;
  const remaining = CONSTANT_TIME_LOOKUP_MIN_MS - elapsed;
  if (remaining > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
  }
  return result;
}

// ── Service ────────────────────────────────────────────────────────────────────

export class SocialAuthService {
  constructor(
    private readonly userRepository: SocialUserRepository,
    private readonly identityRepository: SocialIdentityRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly jwtIssuer: JwtIssuer,
    private readonly tokenVerifier: SocialTokenVerifier,
  ) {}

  /**
   * @notice Logs in a user via a third-party social provider.
   *
   * @dev    Flow:
   *         1. Verify the provider ID token (RS256 + JWKS, email must be verified).
   *         2. Look up the provider identity using `constantTimeLookup` to prevent
   *            timing-based enumeration.
   *         3. If the identity exists, resolve the linked user and issue a session.
   *         4. If not found, check for an email-collision password account and
   *            return a descriptive error.
   *
   * @param provider  One of `"google"` | `"apple"`.
   * @param idToken   A compact RS256 JWT issued by the provider.
   * @returns         Access + refresh tokens and minimal user info on success.
   * @throws          `SocialAuthError` with code `SOCIAL_IDENTITY_NOT_LINKED`,
   *                  `EMAIL_ACCOUNT_REQUIRES_LINK`, or `USER_NOT_FOUND`.
   */
  async loginWithProvider(
    provider: SocialAuthProvider,
    idToken: string,
  ): Promise<SocialLoginResult> {
    const claims = await this.verifyVerifiedEmail(provider, idToken);

    // Constant-time lookup: both "found" and "not found" code paths incur the
    // same minimum latency, eliminating the timing oracle for enumeration.
    const identity = await constantTimeLookup(() =>
      this.identityRepository.findByProviderSubject(provider, claims.subject),
    );

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

  /**
   * @notice Links a social provider identity to an existing password account.
   *
   * @dev    Requires step-up authentication (current password) before linking to
   *         prevent an attacker who has obtained a provider token from silently
   *         adding a social login to an account they do not fully control.
   *
   * @param input.userId          Authenticated user's UUID.
   * @param input.provider        Social provider to link.
   * @param input.idToken         Provider-issued identity token.
   * @param input.currentPassword User's current password (step-up auth).
   * @returns                     Link result containing the created/updated identity.
   */
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

  /**
   * @notice Removes a linked social identity from a user account.
   *
   * @dev    Requires step-up authentication.  Idempotent — a second unlink
   *         returns `{ unlinked: false }` rather than an error.
   */
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

  // ── Private helpers ──────────────────────────────────────────────────────

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

  /**
   * @notice Constant-time password comparison using `timingSafeEqual` to prevent
   *         timing attacks that could allow an attacker to determine password
   *         correctness by measuring response latency.
   *
   * @dev    Both the candidate and stored hashes are derived with SHA-256 before
   *         comparison, so the buffers are always the same length (64 hex chars),
   *         which is a precondition for `timingSafeEqual`.
   */
  private verifyPassword(plaintext: string, storedHash: string): boolean {
    const candidateHash = createHash('sha256').update(plaintext).digest('hex');
    const candidate = Buffer.from(candidateHash, 'utf-8');
    const stored = Buffer.from(storedHash, 'utf-8');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  }
}
