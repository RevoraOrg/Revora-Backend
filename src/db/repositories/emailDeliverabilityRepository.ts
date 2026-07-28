import { Pool, QueryResult } from 'pg';

/**
 * Per-domain delivery and alignment state.
 */
export interface DomainDeliverability {
  id: string;
  domain: string;
  provider: string;
  dkim_status: string | null;
  spf_status: string | null;
  dmarc_status: string | null;
  dmarc_policy: string | null;
  aligned: boolean;
  sent_count: number;
  bounce_count: number;
  complaint_count: number;
  block_count: number;
  bounce_ratio: number;
  last_sent_at: Date | null;
  last_bounce_at: Date | null;
  last_alarm_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Email suppression entry.
 */
export interface EmailSuppression {
  id: string;
  email: string;
  reason: 'hard_bounce' | 'soft_bounce' | 'spam_complaint' | 'block' | 'manual';
  bounce_event_id: string | null;
  created_at: Date;
  expires_at: Date | null;
}

/**
 * Provider-agnostic bounce event.
 */
export interface BounceEvent {
  id: string;
  email: string;
  domain: string;
  provider: string;
  bounce_type: 'hard_bounce' | 'soft_bounce' | 'block' | 'spam_complaint' | 'unsubscribe' | 'other';
  status_code: string | null;
  provider_event_id: string | null;
  raw_payload: unknown;
  ingested_at: Date;
}

export interface BounceEventInput {
  email: string;
  domain: string;
  provider: string;
  bounce_type: BounceEvent['bounce_type'];
  status_code?: string;
  provider_event_id?: string;
  raw_payload?: unknown;
}

/**
 * Repository for email deliverability tables.
 *
 * All methods use the injected Pool directly.  Callers that need
 * transactional guarantees should pass a PoolClient obtained from
 * pool.connect().
 */
export class EmailDeliverabilityRepository {
  constructor(private readonly db: Pool) {}

  // ---------------------------------------------------------------------------
  // Domain deliverability
  // ---------------------------------------------------------------------------

  /**
   * Upsert a domain record.  Creates one if it doesn't exist, or updates
   * the provider and alignment fields in-place.
   */
  async upsertDomain(
    domain: string,
    provider: string,
    alignment?: {
      dkim_status?: string;
      spf_status?: string;
      dmarc_status?: string;
      dmarc_policy?: string;
      aligned?: boolean;
    },
  ): Promise<DomainDeliverability> {
    const sql = `
      INSERT INTO email_deliverability_domains (domain, provider, dkim_status, spf_status, dmarc_status, dmarc_policy, aligned)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (domain) DO UPDATE SET
        provider = EXCLUDED.provider,
        dkim_status = COALESCE(EXCLUDED.dkim_status, email_deliverability_domains.dkim_status),
        spf_status = COALESCE(EXCLUDED.spf_status, email_deliverability_domains.spf_status),
        dmarc_status = COALESCE(EXCLUDED.dmarc_status, email_deliverability_domains.dmarc_status),
        dmarc_policy = COALESCE(EXCLUDED.dmarc_policy, email_deliverability_domains.dmarc_policy),
        aligned = COALESCE(EXCLUDED.aligned, email_deliverability_domains.aligned)
      RETURNING *`;
    const result: QueryResult<DomainDeliverability> = await this.db.query(sql, [
      domain,
      provider,
      alignment?.dkim_status ?? null,
      alignment?.spf_status ?? null,
      alignment?.dmarc_status ?? null,
      alignment?.dmarc_policy ?? null,
      alignment?.aligned ?? false,
    ]);
    return result.rows[0];
  }

  /**
   * Find a domain record by domain name.
   */
  async findByDomain(domain: string): Promise<DomainDeliverability | null> {
    const result: QueryResult<DomainDeliverability> = await this.db.query(
      `SELECT * FROM email_deliverability_domains WHERE domain = $1`,
      [domain],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Increment send counter and update last_sent_at.
   */
  async recordSend(domain: string): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains
       SET sent_count = sent_count + 1,
           bounce_ratio = CAST(bounce_count AS DOUBLE PRECISION) / NULLIF(sent_count + 1, 0),
           last_sent_at = NOW()
       WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * Increment bounce counter and update last_bounce_at + bounce_ratio.
   */
  async recordBounce(domain: string): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains
       SET bounce_count = bounce_count + 1,
           bounce_ratio = CAST(bounce_count + 1 AS DOUBLE PRECISION) / NULLIF(sent_count, 0),
           last_bounce_at = NOW()
       WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * Increment complaint counter.
   */
  async recordComplaint(domain: string): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains
       SET complaint_count = complaint_count + 1
       WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * Increment block counter.
   */
  async recordBlock(domain: string): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains
       SET block_count = block_count + 1
       WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * Update alignment state for a domain.
   */
  async recordAlignment(
    domain: string,
    alignment: {
      dkim_status?: string;
      spf_status?: string;
      dmarc_status?: string;
      dmarc_policy?: string;
      aligned: boolean;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains
       SET dkim_status = COALESCE($2, dkim_status),
           spf_status = COALESCE($3, spf_status),
           dmarc_status = COALESCE($4, dmarc_status),
           dmarc_policy = COALESCE($5, dmarc_policy),
           aligned = $6
       WHERE domain = $1`,
      [
        domain,
        alignment.dkim_status ?? null,
        alignment.spf_status ?? null,
        alignment.dmarc_status ?? null,
        alignment.dmarc_policy ?? null,
        alignment.aligned,
      ],
    );
  }

  /**
   * Mark that an alignment alarm was raised for this domain.
   */
  async markAlarmRaised(domain: string): Promise<void> {
    await this.db.query(
      `UPDATE email_deliverability_domains SET last_alarm_at = NOW() WHERE domain = $1`,
      [domain],
    );
  }

  /**
   * List domains with alignment failures (aligned = FALSE).
   * Optionally filters to only those where alarm has not been raised recently.
   */
  async listAlignmentFailures(alarmCooldownHours = 24): Promise<DomainDeliverability[]> {
    const result: QueryResult<DomainDeliverability> = await this.db.query(
      `SELECT * FROM email_deliverability_domains
       WHERE aligned = FALSE
         AND (last_alarm_at IS NULL
              OR last_alarm_at < NOW() - CAST($1 AS INTERVAL))
       ORDER BY bounce_ratio DESC`,
      [`${alarmCooldownHours} hours`],
    );
    return result.rows;
  }

  /**
   * List domains whose bounce ratio exceeds a threshold.
   */
  async listHighBounceRatioDomains(threshold: number): Promise<DomainDeliverability[]> {
    const result: QueryResult<DomainDeliverability> = await this.db.query(
      `SELECT * FROM email_deliverability_domains
       WHERE sent_count > 0 AND bounce_ratio >= $1
       ORDER BY bounce_ratio DESC`,
      [threshold],
    );
    return result.rows;
  }

  // ---------------------------------------------------------------------------
  // Suppressions
  // ---------------------------------------------------------------------------

  /**
   * Check if an email is currently suppressed.
   */
  async isSuppressed(email: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM email_suppressions
       WHERE email = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [email],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Add a suppression entry.
   */
  async addSuppression(input: {
    email: string;
    reason: EmailSuppression['reason'];
    bounce_event_id?: string;
    expires_at?: Date;
  }): Promise<EmailSuppression> {
    // Use INSERT … ON CONFLICT DO NOTHING so duplicate reason–email pairs are silently ignored
    const result: QueryResult<EmailSuppression> = await this.db.query(
      `INSERT INTO email_suppressions (email, reason, bounce_event_id, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email, reason) DO NOTHING
       RETURNING *`,
      [input.email, input.reason, input.bounce_event_id ?? null, input.expires_at ?? null],
    );
    return result.rows[0];
  }

  /**
   * Remove all suppressions for an email (manual override).
   */
  async removeSuppression(email: string): Promise<void> {
    await this.db.query(
      `DELETE FROM email_suppressions WHERE email = $1`,
      [email],
    );
  }

  /**
   * List all active suppressions for an email.
   */
  async listSuppressions(email: string): Promise<EmailSuppression[]> {
    const result: QueryResult<EmailSuppression> = await this.db.query(
      `SELECT * FROM email_suppressions
       WHERE email = $1
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [email],
    );
    return result.rows;
  }

  // ---------------------------------------------------------------------------
  // Bounce events
  // ---------------------------------------------------------------------------

  /**
   * Insert a bounce event (provider-agnostic).
   */
  async insertBounceEvent(input: BounceEventInput): Promise<BounceEvent> {
    const result: QueryResult<BounceEvent> = await this.db.query(
      `INSERT INTO email_bounce_events (email, domain, provider, bounce_type, status_code, provider_event_id, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        input.email,
        input.domain,
        input.provider,
        input.bounce_type,
        input.status_code ?? null,
        input.provider_event_id ?? null,
        input.raw_payload ? JSON.stringify(input.raw_payload) : null,
      ],
    );
    return result.rows[0];
  }

  /**
   * List bounce events for an email (reverse chronological).
   */
  async listBounceEvents(email: string, limit = 50): Promise<BounceEvent[]> {
    const result: QueryResult<BounceEvent> = await this.db.query(
      `SELECT * FROM email_bounce_events
       WHERE email = $1
       ORDER BY ingested_at DESC
       LIMIT $2`,
      [email, limit],
    );
    return result.rows;
  }
}

