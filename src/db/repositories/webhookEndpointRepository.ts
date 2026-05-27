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

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  payload: any;
  attempts: number;
  status: 'pending' | 'completed' | 'failed' | 'dead_letter';
  next_retry_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
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

  async findByUrl(url: string): Promise<WebhookEndpoint | null> {
    const result: QueryResult<WebhookEndpoint> = await this.db.query(
      `SELECT * FROM webhook_endpoints WHERE url = $1 AND active = TRUE LIMIT 1`,
      [url]
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

  // Delivery methods
  async createDelivery(delivery: Partial<WebhookDelivery>): Promise<WebhookDelivery> {
    const result: QueryResult<WebhookDelivery> = await this.db.query(
      `INSERT INTO webhook_deliveries (endpoint_id, payload, attempts, status, next_retry_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        delivery.endpoint_id,
        JSON.stringify(delivery.payload),
        delivery.attempts || 0,
        delivery.status || 'pending',
        delivery.next_retry_at,
        delivery.last_error,
      ]
    );
    return this.mapDelivery(result.rows[0]);
  }

  async updateDelivery(id: string, updates: Partial<WebhookDelivery>): Promise<WebhookDelivery> {
    const fields = Object.keys(updates).filter(k => k !== 'id');
    const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const values = fields.map(f => f === 'payload' ? JSON.stringify(updates[f]) : updates[f as keyof WebhookDelivery]);

    const result: QueryResult<WebhookDelivery> = await this.db.query(
      `UPDATE webhook_deliveries SET ${setClause} WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    return this.mapDelivery(result.rows[0]);
  }

  async getPendingDeliveries(): Promise<WebhookDelivery[]> {
    const result: QueryResult<WebhookDelivery> = await this.db.query(
      `SELECT * FROM webhook_deliveries
       WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY created_at ASC`
    );
    return result.rows.map(row => this.mapDelivery(row));
  }

  async findDeliveryById(id: string): Promise<WebhookDelivery | null> {
    const result: QueryResult<WebhookDelivery> = await this.db.query(
      `SELECT * FROM webhook_deliveries WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.mapDelivery(result.rows[0]) : null;
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

  private mapDelivery(row: any): WebhookDelivery {
    return {
      id: row.id,
      endpoint_id: row.endpoint_id,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      attempts: row.attempts,
      status: row.status,
      next_retry_at: row.next_retry_at ? new Date(row.next_retry_at) : null,
      last_error: row.last_error,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
