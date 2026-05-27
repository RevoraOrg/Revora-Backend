import { randomUUID } from 'crypto';
import {
  signPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_EVENT_HEADER,
} from '../lib/webhookSignature';
import { Logger } from '../lib/logger';

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
  logger?: Logger;
}

// Re-export signPayload so existing consumers keep working.
export { signPayload } from '../lib/webhookSignature';

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
  private readonly logger: Logger;

  constructor(
    private readonly endpointRepo: IWebhookEndpointRepository,
    options: WebhookServiceOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.logger = options.logger ?? new Logger({ serviceName: 'webhook-service' });
  }

  /**
   * Emits a webhook event to all subscribed endpoints (fire-and-forget).
   */
  async emit<T>(event: WebhookEventType, data: T): Promise<void> {
    let endpoints: WebhookEndpointRecord[];
    try {
      endpoints = await this.endpointRepo.listActiveByEvent(event);
    } catch (err) {
      this.logger.error('Failed to fetch webhook endpoints', {
        event,
        error: err,
      });
      return;
    }

    const payload: WebhookPayload<T> = {
      id: randomUUID(),
      event,
      payload: data,
      timestamp: new Date().toISOString(),
    };

    this.logger.info('Emitting webhook event', {
      event,
      payloadId: payload.id,
      endpointCount: endpoints.length,
    });

    for (const endpoint of endpoints) {
      void this.deliver(endpoint, payload).catch((err) => {
        this.logger.error('Webhook delivery error', {
          endpointId: endpoint.id,
          endpointUrl: endpoint.url,
          event,
          payloadId: payload.id,
          error: err,
        });
      });
    }
  }

  /**
   * Performs a single delivery attempt without retries.
   * Returns the status code and any error message.
   */
  async sendAttempt<T>(
    endpoint: WebhookEndpointRecord,
    payload: WebhookPayload<T>
  ): Promise<{ statusCode?: number; error?: string; success: boolean }> {
    const body = JSON.stringify(payload);
    const timestamp = Date.now().toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [WEBHOOK_SIGNATURE_HEADER]: signPayload(endpoint.secret, body, timestamp),
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_EVENT_HEADER]: payload.event,
        },
        body,
        signal: controller.signal,
      });

      return {
        statusCode: response.status,
        success: response.ok,
        error: response.ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err) {
      console.error(`[WebhookService] sendAttempt error: ${err}`);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutId);
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

    this.logger.debug('Starting webhook delivery', {
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      event: payload.event,
      payloadId: payload.id,
    });

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (attempt > 1) {
        const delay = this.initialDelayMs * Math.pow(2, attempt - 2);
        this.logger.debug('Retrying webhook delivery', {
          endpointId: endpoint.id,
          attempt,
          delayMs: delay,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      attempts = attempt;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const timestamp = Date.now().toString();
        let response: Response;
        try {
          response = await fetch(endpoint.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [WEBHOOK_SIGNATURE_HEADER]: signPayload(endpoint.secret, body, timestamp),
              [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
              [WEBHOOK_EVENT_HEADER]: payload.event,
            },
            body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        lastStatusCode = response.status;

        if (response.ok) {
          this.logger.info('Webhook delivered successfully', {
            endpointId: endpoint.id,
            endpointUrl: endpoint.url,
            event: payload.event,
            payloadId: payload.id,
            attempts,
            statusCode: response.status,
          });
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
          this.logger.warn('Webhook delivery failed with non-retryable error', {
            endpointId: endpoint.id,
            endpointUrl: endpoint.url,
            event: payload.event,
            payloadId: payload.id,
            statusCode: response.status,
            attempts,
          });
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
        this.logger.warn('Webhook delivery attempt failed', {
          endpointId: endpoint.id,
          attempt,
          statusCode: response.status,
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn('Webhook delivery attempt error', {
          endpointId: endpoint.id,
          attempt,
          error: err,
        });
      }
    }

    this.logger.error('Webhook delivery failed after all retries', {
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      event: payload.event,
      payloadId: payload.id,
      attempts,
      lastStatusCode,
      lastError,
    });

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
