/**
 * @file socialLinkAttemptStore.ts
 *
 * @notice Persistence layer for social account-linking attempts.
 *
 * @dev The anomaly detector keys on `(provider, provider_subject)` and counts
 *      the number of *distinct* candidate user accounts that a single social
 *      identity has been attempted against within a sliding window.  A store
 *      must therefore be able to:
 *
 *        1. Record every link attempt (idempotent per candidate account, so a
 *           repeated attempt against the same account is counted once).
 *        2. Return the distinct candidate user IDs observed within a window.
 *
 *      Two implementations are provided:
 *      - `InMemorySocialLinkAttemptStore` — default for tests / single-instance
 *        development.  Mirrors the convention used by the anti-enumeration
 *        middleware (in-process store; swap for a shared store in multi-instance
 *        deployments).
 *      - `PgSocialLinkAttemptStore` — PostgreSQL-backed store for production,
 *        backed by the `social_link_attempts` table (migration 025).
 *
 * Security assumptions:
 * - Provider subjects are OAuth `sub` claims from verified ID tokens only; the
 *   store never logs the raw ID token.
 * - The store contains no PII beyond user IDs already visible to the system.
 */

import { Pool } from 'pg';
import { SocialAuthProvider } from './types';

/**
 * Outcome of a single social account-linking attempt.
 *
 * Every attempt is recorded regardless of outcome so the anomaly detector can
 * spot a single social identity being sprayed across many candidate accounts.
 */
export type SocialLinkAttemptOutcome =
  | 'link_success' // PoP passed and identity linked
  | 'step_up_failed' // PoP (password re-entry) failed
  | 'identity_conflict' // social sub already linked to another account
  | 'email_conflict'; // provider email belongs to another account

/**
 * A single recorded social account-linking attempt.
 */
export interface SocialLinkAttempt {
  /** Provider the social identity belongs to (`google` | `apple`). */
  provider: SocialAuthProvider;
  /** Verified provider subject (`sub` claim) being linked. */
  providerSubject: string;
  /** The Revora account the identity was attempted against. */
  userId: string;
  /** How the attempt ended. */
  outcome: SocialLinkAttemptOutcome;
  /** When the attempt occurred. */
  attemptedAt: Date;
}

/**
 * Contract any link-attempt store must satisfy.
 */
export interface SocialLinkAttemptStore {
  /**
   * Persist a link attempt.  Repeated attempts for the same
   * `(provider, provider_subject, user_id)` triple must not create duplicates
   * so that each candidate account is counted exactly once.
   */
  recordAttempt(attempt: SocialLinkAttempt): Promise<void>;

  /**
   * Return the distinct candidate user IDs for a social identity observed
   * since `since` (inclusive).
   */
  listCandidateUserIds(
    provider: SocialAuthProvider,
    providerSubject: string,
    since: Date,
  ): Promise<string[]>;

  /** Clear all recorded attempts.  Test-only helper. */
  reset(): Promise<void>;
}

/**
 * In-process store.  Suitable for single-instance deployments and unit tests.
 *
 * @dev For multi-instance deployments replace with a shared store (Redis or
 *      the `PgSocialLinkAttemptStore` below) so all instances observe the same
 *      attempt history.
 */
export class InMemorySocialLinkAttemptStore implements SocialLinkAttemptStore {
  private attempts: SocialLinkAttempt[] = [];
  private readonly seen = new Set<string>();

  async recordAttempt(attempt: SocialLinkAttempt): Promise<void> {
    const key = `${attempt.provider}:${attempt.providerSubject}:${attempt.userId}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.attempts.push(attempt);
  }

  async listCandidateUserIds(
    provider: SocialAuthProvider,
    providerSubject: string,
    since: Date,
  ): Promise<string[]> {
    const ids = new Set<string>();
    const sinceMs = since.getTime();
    for (const attempt of this.attempts) {
      if (
        attempt.provider === provider &&
        attempt.providerSubject === providerSubject &&
        attempt.attemptedAt.getTime() >= sinceMs
      ) {
        ids.add(attempt.userId);
      }
    }
    return [...ids];
  }

  async reset(): Promise<void> {
    this.attempts = [];
    this.seen.clear();
  }
}

/**
 * PostgreSQL-backed store.
 *
 * @dev Backed by the `social_link_attempts` table (migration 025).  The
 *      `(provider, provider_subject, user_id)` primary key guarantees each
 *      candidate account is counted exactly once even under concurrent
 *      link attempts.
 */
export class PgSocialLinkAttemptStore implements SocialLinkAttemptStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async recordAttempt(attempt: SocialLinkAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO social_link_attempts
         (provider, provider_subject, user_id, outcome, attempted_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_subject, user_id)
       DO UPDATE SET outcome = EXCLUDED.outcome, attempted_at = EXCLUDED.attempted_at`,
      [attempt.provider, attempt.providerSubject, attempt.userId, attempt.outcome, attempt.attemptedAt],
    );
  }

  async listCandidateUserIds(
    provider: SocialAuthProvider,
    providerSubject: string,
    since: Date,
  ): Promise<string[]> {
    const result = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
         FROM social_link_attempts
        WHERE provider = $1 AND provider_subject = $2 AND attempted_at >= $3`,
      [provider, providerSubject, since],
    );
    return result.rows.map((row) => row.user_id);
  }

  async reset(): Promise<void> {
    await this.pool.query('DELETE FROM social_link_attempts');
  }
}
