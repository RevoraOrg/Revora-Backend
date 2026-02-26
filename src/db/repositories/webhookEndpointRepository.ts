import { Pool, QueryResult } from 'pg';

export interface WebhookEndpoint {
  id: string;
  owner_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWebhookEndpointInput {
  owner_id: string;
  url: string;
  secret: string;
  events: string[];
}

export class WebhookEndpointRepository {
  constructor(private readonly db: Pool) {}

  async create(input: CreateWebhookEndpointInput): Promise<WebhookEndpoint> {
    const result: QueryResult<WebhookEndpoint> = await this.db.query(
      `INSERT INTO webhook_endpoints (owner_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.owner_id, input.url, input.secret, input.events]
    );
    return this.map(result.rows[0]);
  }

  async findById(id: string): Promise<WebhookEndpoint | null> {
    const result: QueryResult<WebhookEndpoint> = await this.db.query(
      `SELECT * FROM webhook_endpoints WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.map(result.rows[0]) : null;
  }

  async listByOwner(ownerId: string): Promise<WebhookEndpoint[]> {
    const result: QueryResult<WebhookEndpoint> = await this.db.query(
      `SELECT * FROM webhook_endpoints WHERE owner_id = $1 ORDER BY created_at DESC`,
      [ownerId]
    );
    return result.rows.map((row) => this.map(row));
  }

  async listActiveByEvent(event: string): Promise<WebhookEndpoint[]> {
    const result: QueryResult<WebhookEndpoint> = await this.db.query(
      `SELECT * FROM webhook_endpoints
       WHERE active = TRUE AND $1 = ANY(events)
       ORDER BY created_at ASC`,
      [event]
    );
    return result.rows.map((row) => this.map(row));
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_endpoints SET active = FALSE WHERE id = $1`,
      [id]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query(
      `DELETE FROM webhook_endpoints WHERE id = $1`,
      [id]
    );
  }

  private map(row: WebhookEndpoint): WebhookEndpoint {
    return {
      id: row.id,
      owner_id: row.owner_id,
      url: row.url,
      secret: row.secret,
      events: row.events,
      active: row.active,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
