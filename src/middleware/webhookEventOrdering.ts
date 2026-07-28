/**
 * Webhook Event Ordering Middleware
 * 
 * Handles out-of-order webhook event delivery by tracking event sequences
 * and ensuring events are processed in the correct order.
 * 
 * Security Assumptions:
 * - Event IDs are unique and monotonically increasing or timestamped
 * - Events include sequence numbers or timestamps for ordering
 * - Duplicate events are idempotent (safe to process multiple times)
 * 
 * Abuse/Failure Paths:
 * - Out-of-order delivery (events arrive in wrong sequence)
 * - Duplicate events (same event delivered multiple times)
 * - Missing events (gaps in sequence)
 * - Stale events (very old events arriving late)
 */

import { Logger } from '../lib/logger';
import { Errors } from '../lib/errors';

export interface EventSequence {
  eventId: string;
  sequence: number;
  timestamp: Date;
  processed: boolean;
  processedAt?: Date;
}

export interface EventOrderingConfig {
  /** Maximum time to wait for missing events (ms) */
  maxWaitTimeMs?: number;
  /** Maximum number of events to buffer */
  maxBufferSize?: number;
  /** Enable strict ordering (reject out-of-order events) */
  strictOrdering?: boolean;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Event ordering tracker for handling out-of-order webhook deliveries
 */
export class EventOrderingTracker {
  private readonly logger: Logger;
  private readonly maxWaitTimeMs: number;
  private readonly maxBufferSize: number;
  private readonly strictOrdering: boolean;
  
  // Track last processed sequence per entity
  private lastProcessedSequence: Map<string, number> = new Map();
  
  // Buffer for out-of-order events
  private eventBuffer: Map<string, EventSequence[]> = new Map();

  constructor(config: EventOrderingConfig = {}) {
    this.logger = config.logger ?? new Logger({ serviceName: 'webhook-event-ordering' });
    this.maxWaitTimeMs = config.maxWaitTimeMs ?? 60000; // 1 minute
    this.maxBufferSize = config.maxBufferSize ?? 100;
    this.strictOrdering = config.strictOrdering ?? false;
  }

  /**
   * Check if an event should be processed based on sequence ordering
   * 
   * @param entityId - Entity identifier (e.g., user ID, offering ID)
   * @param eventId - Unique event identifier
   * @param sequence - Event sequence number
   * @param timestamp - Event timestamp
   * @returns Decision on whether to process, buffer, or reject the event
   */
  shouldProcessEvent(
    entityId: string,
    eventId: string,
    sequence: number,
    timestamp: Date
  ): EventOrderingDecision {
    const lastSequence = this.lastProcessedSequence.get(entityId) ?? -1;

    // Check for duplicate event
    if (sequence <= lastSequence) {
      this.logger.warn('Duplicate or stale event detected', {
        entityId,
        eventId,
        sequence,
        lastSequence,
      });
      
      return {
        action: 'reject',
        reason: 'duplicate_or_stale',
        message: `Event sequence ${sequence} already processed (last: ${lastSequence})`,
      };
    }

    // Check if event is next in sequence
    if (sequence === lastSequence + 1) {
      this.logger.debug('Event in correct sequence', {
        entityId,
        eventId,
        sequence,
      });
      
      return {
        action: 'process',
        reason: 'in_sequence',
      };
    }

    // Event is out of order (future event)
    if (sequence > lastSequence + 1) {
      if (this.strictOrdering) {
        this.logger.warn('Out-of-order event rejected (strict mode)', {
          entityId,
          eventId,
          sequence,
          lastSequence,
          gap: sequence - lastSequence - 1,
        });
        
        return {
          action: 'reject',
          reason: 'out_of_order',
          message: `Event sequence ${sequence} is out of order (expected: ${lastSequence + 1})`,
        };
      }

      // Buffer the event and wait for missing events
      const buffered = this.bufferEvent(entityId, eventId, sequence, timestamp);
      
      if (!buffered) {
        this.logger.error('Failed to buffer out-of-order event', {
          entityId,
          eventId,
          sequence,
          bufferSize: this.getBufferSize(entityId),
        });
        
        return {
          action: 'reject',
          reason: 'buffer_full',
          message: 'Event buffer is full, cannot buffer out-of-order event',
        };
      }

      this.logger.info('Event buffered for later processing', {
        entityId,
        eventId,
        sequence,
        lastSequence,
        gap: sequence - lastSequence - 1,
      });

      return {
        action: 'buffer',
        reason: 'out_of_order',
        message: `Event buffered, waiting for sequence ${lastSequence + 1}`,
      };
    }

    // Should never reach here
    return {
      action: 'reject',
      reason: 'unknown',
      message: 'Unknown event ordering state',
    };
  }

  /**
   * Mark an event as processed and check if buffered events can now be processed
   * 
   * @param entityId - Entity identifier
   * @param sequence - Processed event sequence
   * @returns Array of buffered events that can now be processed
   */
  markProcessed(entityId: string, sequence: number): EventSequence[] {
    this.lastProcessedSequence.set(entityId, sequence);
    
    this.logger.debug('Event marked as processed', {
      entityId,
      sequence,
    });

    // Check if any buffered events can now be processed
    return this.getProcessableBufferedEvents(entityId);
  }

  /**
   * Buffer an out-of-order event for later processing
   */
  private bufferEvent(
    entityId: string,
    eventId: string,
    sequence: number,
    timestamp: Date
  ): boolean {
    const buffer = this.eventBuffer.get(entityId) ?? [];
    
    // Check buffer size limit
    if (buffer.length >= this.maxBufferSize) {
      return false;
    }

    // Check if event is too old
    const age = Date.now() - timestamp.getTime();
    if (age > this.maxWaitTimeMs) {
      this.logger.warn('Event too old to buffer', {
        entityId,
        eventId,
        sequence,
        ageMs: age,
      });
      return false;
    }

    // Add to buffer
    buffer.push({
      eventId,
      sequence,
      timestamp,
      processed: false,
    });

    // Sort buffer by sequence
    buffer.sort((a, b) => a.sequence - b.sequence);

    this.eventBuffer.set(entityId, buffer);
    
    return true;
  }

  /**
   * Get buffered events that can now be processed
   */
  private getProcessableBufferedEvents(entityId: string): EventSequence[] {
    const buffer = this.eventBuffer.get(entityId);
    if (!buffer || buffer.length === 0) {
      return [];
    }

    const lastSequence = this.lastProcessedSequence.get(entityId) ?? -1;
    const processable: EventSequence[] = [];

    // Find consecutive events starting from lastSequence + 1
    let expectedSequence = lastSequence + 1;
    
    for (const event of buffer) {
      if (event.sequence === expectedSequence && !event.processed) {
        processable.push(event);
        expectedSequence++;
      } else if (event.sequence > expectedSequence) {
        // Gap in sequence, stop here
        break;
      }
    }

    // Remove processable events from buffer
    if (processable.length > 0) {
      const remainingBuffer = buffer.filter(
        e => !processable.some(p => p.eventId === e.eventId)
      );
      
      if (remainingBuffer.length === 0) {
        this.eventBuffer.delete(entityId);
      } else {
        this.eventBuffer.set(entityId, remainingBuffer);
      }

      this.logger.info('Buffered events ready for processing', {
        entityId,
        count: processable.length,
        sequences: processable.map(e => e.sequence),
      });
    }

    return processable;
  }

  /**
   * Clean up stale buffered events
   */
  cleanupStaleEvents(): number {
    let cleaned = 0;
    const now = Date.now();

    for (const [entityId, buffer] of this.eventBuffer.entries()) {
      const validEvents = buffer.filter(event => {
        const age = now - event.timestamp.getTime();
        if (age > this.maxWaitTimeMs) {
          this.logger.warn('Removing stale buffered event', {
            entityId,
            eventId: event.eventId,
            sequence: event.sequence,
            ageMs: age,
          });
          cleaned++;
          return false;
        }
        return true;
      });

      if (validEvents.length === 0) {
        this.eventBuffer.delete(entityId);
      } else if (validEvents.length < buffer.length) {
        this.eventBuffer.set(entityId, validEvents);
      }
    }

    if (cleaned > 0) {
      this.logger.info('Cleaned up stale buffered events', { count: cleaned });
    }

    return cleaned;
  }

  /**
   * Get buffer size for an entity
   */
  private getBufferSize(entityId: string): number {
    return this.eventBuffer.get(entityId)?.length ?? 0;
  }

  /**
   * Get statistics about event ordering
   */
  getStats(): EventOrderingStats {
    let totalBuffered = 0;
    let maxBufferSize = 0;

    for (const buffer of this.eventBuffer.values()) {
      totalBuffered += buffer.length;
      maxBufferSize = Math.max(maxBufferSize, buffer.length);
    }

    return {
      entitiesTracked: this.lastProcessedSequence.size,
      entitiesWithBufferedEvents: this.eventBuffer.size,
      totalBufferedEvents: totalBuffered,
      maxBufferSizePerEntity: maxBufferSize,
    };
  }
}

export interface EventOrderingDecision {
  action: 'process' | 'buffer' | 'reject';
  reason: string;
  message?: string;
}

export interface EventOrderingStats {
  entitiesTracked: number;
  entitiesWithBufferedEvents: number;
  totalBufferedEvents: number;
  maxBufferSizePerEntity: number;
}

/**
 * Express middleware for webhook event ordering
 */
export function createEventOrderingMiddleware(tracker: EventOrderingTracker) {
  return async (req: any, res: any, next: any) => {
    const event = req.body;
    
    // Extract ordering information from event
    const entityId = event.entityId || event.data?.id;
    const eventId = event.id;
    const sequence = event.sequence || event.data?.sequence;
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();

    if (!entityId || !eventId || sequence === undefined) {
      return next(Errors.badRequest('Event missing required ordering fields'));
    }

    // Check event ordering
    const decision = tracker.shouldProcessEvent(entityId, eventId, sequence, timestamp);

    if (decision.action === 'reject') {
      return res.status(409).json({
        success: false,
        error: 'Event ordering conflict',
        code: decision.reason.toUpperCase(),
        message: decision.message,
      });
    }

    if (decision.action === 'buffer') {
      return res.status(202).json({
        success: true,
        message: decision.message,
        buffered: true,
      });
    }

    // Process event
    req.eventOrdering = { entityId, sequence };
    next();
  };
}
