import { EventOrderingTracker } from './webhookEventOrdering';
import { Logger } from '../lib/logger';

describe('EventOrderingTracker', () => {
  let tracker: EventOrderingTracker;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    tracker = new EventOrderingTracker({
      maxWaitTimeMs: 60000,
      maxBufferSize: 100,
      strictOrdering: false,
      logger: mockLogger,
    });
  });

  describe('shouldProcessEvent', () => {
    it('should process first event in sequence', () => {
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-1',
        0,
        new Date()
      );

      expect(decision.action).toBe('process');
      expect(decision.reason).toBe('in_sequence');
    });

    it('should process events in correct sequence', () => {
      tracker.markProcessed('entity-1', 0);
      
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-2',
        1,
        new Date()
      );

      expect(decision.action).toBe('process');
      expect(decision.reason).toBe('in_sequence');
    });

    it('should reject duplicate events', () => {
      tracker.markProcessed('entity-1', 5);
      
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-dup',
        5,
        new Date()
      );

      expect(decision.action).toBe('reject');
      expect(decision.reason).toBe('duplicate_or_stale');
    });

    it('should reject stale events', () => {
      tracker.markProcessed('entity-1', 10);
      
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-old',
        5,
        new Date()
      );

      expect(decision.action).toBe('reject');
      expect(decision.reason).toBe('duplicate_or_stale');
    });

    it('should buffer out-of-order events', () => {
      tracker.markProcessed('entity-1', 0);
      
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-3',
        3,
        new Date()
      );

      expect(decision.action).toBe('buffer');
      expect(decision.reason).toBe('out_of_order');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Event buffered for later processing',
        expect.objectContaining({
          entityId: 'entity-1',
          sequence: 3,
          gap: 2,
        })
      );
    });

    it('should reject out-of-order events in strict mode', () => {
      const strictTracker = new EventOrderingTracker({
        strictOrdering: true,
        logger: mockLogger,
      });

      strictTracker.markProcessed('entity-1', 0);
      
      const decision = strictTracker.shouldProcessEvent(
        'entity-1',
        'event-3',
        3,
        new Date()
      );

      expect(decision.action).toBe('reject');
      expect(decision.reason).toBe('out_of_order');
    });

    it('should reject events when buffer is full', () => {
      const smallBufferTracker = new EventOrderingTracker({
        maxBufferSize: 2,
        logger: mockLogger,
      });

      smallBufferTracker.markProcessed('entity-1', 0);
      
      // Fill buffer
      smallBufferTracker.shouldProcessEvent('entity-1', 'event-3', 3, new Date());
      smallBufferTracker.shouldProcessEvent('entity-1', 'event-4', 4, new Date());
      
      // Try to add one more
      const decision = smallBufferTracker.shouldProcessEvent(
        'entity-1',
        'event-5',
        5,
        new Date()
      );

      expect(decision.action).toBe('reject');
      expect(decision.reason).toBe('buffer_full');
    });
  });

  describe('markProcessed', () => {
    it('should mark event as processed and return empty array when no buffered events', () => {
      const processable = tracker.markProcessed('entity-1', 0);

      expect(processable).toEqual([]);
    });

    it('should return buffered events that can now be processed', () => {
      tracker.markProcessed('entity-1', 0);
      
      // Buffer events 2 and 3
      tracker.shouldProcessEvent('entity-1', 'event-3', 3, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-2', 2, new Date());
      
      // Process event 1
      const processable = tracker.markProcessed('entity-1', 1);

      expect(processable).toHaveLength(2);
      expect(processable[0].sequence).toBe(2);
      expect(processable[1].sequence).toBe(3);
    });

    it('should only return consecutive buffered events', () => {
      tracker.markProcessed('entity-1', 0);
      
      // Buffer events 2, 3, and 5 (gap at 4)
      tracker.shouldProcessEvent('entity-1', 'event-2', 2, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-3', 3, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-5', 5, new Date());
      
      // Process event 1
      const processable = tracker.markProcessed('entity-1', 1);

      // Should only return 2 and 3, not 5 (gap at 4)
      expect(processable).toHaveLength(2);
      expect(processable[0].sequence).toBe(2);
      expect(processable[1].sequence).toBe(3);
    });

    it('should handle multiple entities independently', () => {
      tracker.markProcessed('entity-1', 0);
      tracker.markProcessed('entity-2', 0);
      
      // Buffer events for both entities
      tracker.shouldProcessEvent('entity-1', 'event-1-2', 2, new Date());
      tracker.shouldProcessEvent('entity-2', 'event-2-2', 2, new Date());
      
      // Process event 1 for entity-1 only
      const processable1 = tracker.markProcessed('entity-1', 1);
      
      expect(processable1).toHaveLength(1);
      expect(processable1[0].eventId).toBe('event-1-2');
      
      // Entity-2's buffer should be unchanged
      const processable2 = tracker.markProcessed('entity-2', 0);
      expect(processable2).toHaveLength(0);
    });
  });

  describe('cleanupStaleEvents', () => {
    it('should remove events older than maxWaitTimeMs', () => {
      const shortWaitTracker = new EventOrderingTracker({
        maxWaitTimeMs: 100,
        logger: mockLogger,
      });

      shortWaitTracker.markProcessed('entity-1', 0);
      
      // Buffer an event
      const oldTimestamp = new Date(Date.now() - 200);
      shortWaitTracker.shouldProcessEvent('entity-1', 'event-old', 2, oldTimestamp);
      
      // Clean up
      const cleaned = shortWaitTracker.cleanupStaleEvents();

      expect(cleaned).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Removing stale buffered event',
        expect.objectContaining({
          entityId: 'entity-1',
          eventId: 'event-old',
        })
      );
    });

    it('should not remove recent events', () => {
      tracker.markProcessed('entity-1', 0);
      
      // Buffer a recent event
      tracker.shouldProcessEvent('entity-1', 'event-recent', 2, new Date());
      
      // Clean up
      const cleaned = tracker.cleanupStaleEvents();

      expect(cleaned).toBe(0);
    });

    it('should handle multiple entities', () => {
      const shortWaitTracker = new EventOrderingTracker({
        maxWaitTimeMs: 100,
        logger: mockLogger,
      });

      shortWaitTracker.markProcessed('entity-1', 0);
      shortWaitTracker.markProcessed('entity-2', 0);
      
      // Buffer old events for both
      const oldTimestamp = new Date(Date.now() - 200);
      shortWaitTracker.shouldProcessEvent('entity-1', 'event-1-old', 2, oldTimestamp);
      shortWaitTracker.shouldProcessEvent('entity-2', 'event-2-old', 2, oldTimestamp);
      
      // Clean up
      const cleaned = shortWaitTracker.cleanupStaleEvents();

      expect(cleaned).toBe(2);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      tracker.markProcessed('entity-1', 0);
      tracker.markProcessed('entity-2', 0);
      tracker.markProcessed('entity-3', 0);
      
      // Buffer events
      tracker.shouldProcessEvent('entity-1', 'event-1-2', 2, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-1-3', 3, new Date());
      tracker.shouldProcessEvent('entity-2', 'event-2-2', 2, new Date());
      
      const stats = tracker.getStats();

      expect(stats.entitiesTracked).toBe(3);
      expect(stats.entitiesWithBufferedEvents).toBe(2);
      expect(stats.totalBufferedEvents).toBe(3);
      expect(stats.maxBufferSizePerEntity).toBe(2);
    });

    it('should return zero stats for empty tracker', () => {
      const stats = tracker.getStats();

      expect(stats.entitiesTracked).toBe(0);
      expect(stats.entitiesWithBufferedEvents).toBe(0);
      expect(stats.totalBufferedEvents).toBe(0);
      expect(stats.maxBufferSizePerEntity).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid sequential events', () => {
      for (let i = 0; i < 100; i++) {
        const decision = tracker.shouldProcessEvent(
          'entity-1',
          `event-${i}`,
          i,
          new Date()
        );
        
        expect(decision.action).toBe('process');
        tracker.markProcessed('entity-1', i);
      }
    });

    it('should handle large gaps in sequence', () => {
      tracker.markProcessed('entity-1', 0);
      
      const decision = tracker.shouldProcessEvent(
        'entity-1',
        'event-1000',
        1000,
        new Date()
      );

      expect(decision.action).toBe('buffer');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Event buffered for later processing',
        expect.objectContaining({
          gap: 999,
        })
      );
    });

    it('should handle events arriving in reverse order', () => {
      tracker.markProcessed('entity-1', 0);
      
      // Buffer events in reverse order
      tracker.shouldProcessEvent('entity-1', 'event-5', 5, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-4', 4, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-3', 3, new Date());
      tracker.shouldProcessEvent('entity-1', 'event-2', 2, new Date());
      
      // Process event 1
      const processable = tracker.markProcessed('entity-1', 1);

      // Should return all buffered events in correct order
      expect(processable).toHaveLength(4);
      expect(processable.map(e => e.sequence)).toEqual([2, 3, 4, 5]);
    });

    it('should handle concurrent events for same entity', () => {
      tracker.markProcessed('entity-1', 0);
      
      // Simulate concurrent arrival
      const decision1 = tracker.shouldProcessEvent('entity-1', 'event-1a', 1, new Date());
      const decision2 = tracker.shouldProcessEvent('entity-1', 'event-1b', 1, new Date());
      
      expect(decision1.action).toBe('process');
      expect(decision2.action).toBe('reject'); // Duplicate
    });
  });
});
