import { Pool, QueryResult } from 'pg';
import {
  SocialAuthProvider,
  SocialIdentityRecord,
  SocialIdentityRepository as ISocialIdentityRepository,
} from '../../auth/social/types';

interface SocialIdentityRow {
  id: string;
  user_id: string;
  provider: SocialAuthProvider;
  provider_subject: string;
  provider_email: string;
  email_verified: boolean;
  created_at: Date;
  updated_at: Date;
}

export class SocialIdentityRepository implements ISocialIdentityRepository {
  constructor(private readonly db: Pool) {}

  async findByProviderSubject(
    provider: SocialAuthProvider,
    providerSubject: string,
  ): Promise<SocialIdentityRecord | null> {
    const result: QueryResult<SocialIdentityRow> = await this.db.query(
      `
        SELECT *
        FROM social_identities
        WHERE provider = $1 AND provider_subject = $2
        LIMIT 1
      `,
      [provider, providerSubject],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async findByUserAndProvider(
    userId: string,
    provider: SocialAuthProvider,
  ): Promise<SocialIdentityRecord | null> {
    const result: QueryResult<SocialIdentityRow> = await this.db.query(
      `
        SELECT *
        FROM social_identities
        WHERE user_id = $1 AND provider = $2
        LIMIT 1
      `,
      [userId, provider],
    );
    return result.rows[0] ? this.mapRow(result.rows[0]) : null;
  }

  async createIdentity(input: {
    userId: string;
    provider: SocialAuthProvider;
    providerSubject: string;
    providerEmail: string;
    emailVerified: boolean;
  }): Promise<SocialIdentityRecord> {
    const result: QueryResult<SocialIdentityRow> = await this.db.query(
      `
        INSERT INTO social_identities (
          user_id,
          provider,
          provider_subject,
          provider_email,
          email_verified,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        RETURNING *
      `,
      [
        input.userId,
        input.provider,
        input.providerSubject,
        input.providerEmail,
        input.emailVerified,
      ],
    );
    return this.mapRow(result.rows[0]);
  }

  async updateIdentityEmail(id: string, providerEmail: string): Promise<void> {
    await this.db.query(
      `
        UPDATE social_identities
        SET provider_email = $1, email_verified = TRUE, updated_at = NOW()
        WHERE id = $2
      `,
      [providerEmail, id],
    );
  }

  async deleteByUserAndProvider(userId: string, provider: SocialAuthProvider): Promise<boolean> {
    const result = await this.db.query(
      `
        DELETE FROM social_identities
        WHERE user_id = $1 AND provider = $2
      `,
      [userId, provider],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private mapRow(row: SocialIdentityRow): SocialIdentityRecord {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      providerSubject: row.provider_subject,
      providerEmail: row.provider_email,
      emailVerified: row.email_verified,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
