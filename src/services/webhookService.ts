import { createHmac, randomUUID } from 'crypto';

export const WebhookEventType = {
  OFFERING_CREATED: 'offering.created',
  OFFERING_UPDATED: 'offering.updated',
  REVENUE_REPORTED: 'revenue.reported',
  DISTRIBUTION_STARTED: 'distribution.started',
  DISTRIBUTION_COMPLETED: 'distribution.completed',
  PAYOUT_COMPLETED: 'payout.completed',
  PAYOUT_FAILED: 'payout.failed',
} as const;

export type WebhookEventType = (typeof WebhookEventType)[keyof typeof WebhookEventType];

export interface WebhookPayload<T = unknown> {
  id: string;
  event: WebhookEventType;
  payload: T;
  timestamp: string;
}

export interface DeliveryResult {
  endpointId: string;
  url: string;
  success: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  secret: string;
}

export interface IWebhookEndpointRepository {
  listActiveByEvent(event: string): Promise<WebhookEndpointRecord[]>;
}

export interface WebhookServiceOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Signs a webhook payload body with HMAC-SHA256.
 * Returns a string of the form `sha256=<hex>`.
 */
export function signPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Fire-and-forget webhook delivery service with retry logic.
 *
 * Callers invoke `emit(event, data)`. The service fetches all active endpoints
 * subscribed to that event and attempts delivery to each asynchronously.
 *
 * Delivery is retried up to `maxRetries` times using exponential backoff:
 *   attempt 1 – no wait
 *   attempt 2 – initialDelayMs
 *   attempt 3 – initialDelayMs * 2
 *
 * 4xx responses (except 429) are not retried; 5xx and network errors are.
 */
export class WebhookService {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpointRepo: IWebhookEndpointRepository,
    options: WebhookServiceOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  /**
   * Emits a webhook event to all subscribed endpoints (fire-and-forget).
   */
  async emit<T>(event: WebhookEventType, data: T): Promise<void> {
    let endpoints: WebhookEndpointRecord[];
    try {
      endpoints = await this.endpointRepo.listActiveByEvent(event);
    } catch (err) {
      console.error('[WebhookService] Failed to fetch endpoints for event:', event, err);
      return;
    }

    const payload: WebhookPayload<T> = {
      id: randomUUID(),
      event,
      payload: data,
      timestamp: new Date().toISOString(),
    };

    for (const endpoint of endpoints) {
      void this.deliver(endpoint, payload).catch((err) => {
        console.error('[WebhookService] Delivery error for endpoint', endpoint.id, err);
      });
    }
  }

  /**
   * Delivers a webhook payload to a single endpoint with retry logic.
   */
  async deliver<T>(
    endpoint: WebhookEndpointRecord,
    payload: WebhookPayload<T>
  ): Promise<DeliveryResult> {
    const body = JSON.stringify(payload);
    let attempts = 0;
    let lastStatusCode: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (attempt > 1) {
        const delay = this.initialDelayMs * Math.pow(2, attempt - 2);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      attempts = attempt;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
          response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Revora-Signature': signPayload(endpoint.secret, body),
              'X-Revora-Event': payload.event,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        lastStatusCode = response.status;

        if (response.ok) {
          return {
            endpointId: endpoint.id,
            url: endpoint.url,
            success: true,
            attempts,
            statusCode: response.status,
          };
        }

        // 4xx (except 429 Too Many Requests) are non-retryable
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return {
            endpointId: endpoint.id,
            url: endpoint.url,
            success: false,
            attempts,
            statusCode: response.status,
            error: `Non-retryable HTTP ${response.status}`,
          };
        }

        lastError = `HTTP ${response.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      endpointId: endpoint.id,
      url: endpoint.url,
      success: false,
      attempts,
      statusCode: lastStatusCode,
      error: lastError ?? 'Max retries exceeded',
    };
  }
}
