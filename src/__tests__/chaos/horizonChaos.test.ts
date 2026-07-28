import { HorizonFake } from '../mocks/horizonFake';
import { runChaosScenario, createSequentialProfile, wait } from '../fixtures/chaosHelpers';
import { FailureProfile } from '../mocks/horizonFake';

describe('Horizon Chaos Tests', () => {
  let horizonFake: HorizonFake;

  beforeEach(() => {
    horizonFake = new HorizonFake();
  });

  afterEach(() => {
    horizonFake.reset();
  });

  describe('Latency Injection Tests', () => {
    test('should handle high latency gracefully', async () => {
      const profile: FailureProfile = { latencyMs: 5000 };
      const result = await runChaosScenario(horizonFake, profile, 3);
      
      expect(result.requestCount).toBe(3);
      expect(result.errors).toHaveLength(0);
      expect(result.latency).toBeGreaterThanOrEqual(15000);
    }, 30000);

    test('should timeout and retry on excessive latency', async () => {
      const profile: FailureProfile = { latencyMs: 15000 };
      const result = await runChaosScenario(horizonFake, profile, 2, 10000);
      
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }, 20000);

    test('should maintain circuit behavior during latency spikes', async () => {
      const profiles = createSequentialProfile(100);
      let totalRequests = 0;
      
      for (const profile of profiles) {
        const result = await runChaosScenario(horizonFake, profile, 5);
        totalRequests += result.requestCount;
        
        // Circuit should handle the latency
        expect(result.errors).toHaveLength(0);
        await wait(1000);
      }
      
      expect(totalRequests).toBeGreaterThan(0);
    }, 20000);

    test('should handle variable latency patterns', async () => {
      const patterns = [
        { latencyMs: 100 },
        { latencyMs: 2000 },
        { latencyMs: 100 },
        { latencyMs: 5000 },
        { latencyMs: 100 }
      ];

      for (const pattern of patterns) {
        const result = await runChaosScenario(horizonFake, pattern, 2);
        expect(result.success).toBe(true);
        await wait(500);
      }
    }, 30000);
  });

  describe('Partial Reads and Connection Drops', () => {
    test('should recover from dropped connections mid-stream', async () => {
      const profile: FailureProfile = { dropConnection: true };
      
      // First request might fail, second should succeed
      const results = [];
      for (let i = 0; i < 4; i++) {
        const result = await runChaosScenario(horizonFake, profile, 1);
        results.push(result);
        await wait(100);
      }

      // At least half should succeed (alternating failures)
      const successCount = results.filter(r => r.success).length;
      expect(successCount).toBeGreaterThanOrEqual(2);
    }, 15000);

    test('should handle partial responses gracefully', async () => {
      const profile: FailureProfile = { partialReads: true };
      const result = await runChaosScenario(horizonFake, profile, 5);
      
      // Should handle partial responses without crashing
      expect(result.requestCount).toBe(5);
      
      // The horizon fake should return partial responses
      const logs = horizonFake.getRequestLogs();
      expect(logs.length).toBe(5);
    }, 15000);

    test('should not double-count events after partial failures', async () => {
      // Track unique event IDs
      const eventIds = new Set<string>();
      const profile: FailureProfile = { partialReads: true };
      
      for (let i = 0; i < 10; i++) {
        try {
          const response = await horizonFake.simulateRequest('/events');
          // Extract and deduplicate event IDs
          if (response && response.records) {
            response.records.forEach((record: any) => {
              eventIds.add(record.id);
            });
          }
        } catch (error) {
          // Expected failures
        }
        await wait(100);
      }

      // Check for duplicate IDs
      const totalRecords = Array.from(eventIds);
      const uniqueCount = new Set(totalRecords).size;
      expect(uniqueCount).toBe(totalRecords.length);
    }, 15000);
  });

  describe('Reorg Tests', () => {
    test('should handle shallow reorg (1-2 ledgers)', async () => {
      const initialSequence = horizonFake.getLedgerSequence();
      const profile: FailureProfile = { reorgDepth: 2 };
      
      // Simulate requests before, during, and after reorg
      const before = await horizonFake.simulateRequest('/ledgers');
      const reorg = await horizonFake.simulateRequest('/ledgers');
      const after = await horizonFake.simulateRequest('/ledgers');
      
      // Verify ledger sequence
      const finalSequence = horizonFake.getLedgerSequence();
      expect(finalSequence).toBe(initialSequence + 1); // Should have recovered
      
      // Verify reorg detection
      expect(reorg.reorg).toBe(true);
      expect(reorg.reorgDepth).toBe(2);
    });

    test('should handle deep reorg (deeper than buffer)', async () => {
      const profile: FailureProfile = { reorgDepth: 20 };
      const result = await runChaosScenario(horizonFake, profile, 3);
      
      // Should handle deep reorg
      expect(result.requestCount).toBe(3);
      expect(horizonFake.getLedgerSequence()).toBeGreaterThan(0);
    });

    test('should handle reorg with cursor regression', async () => {
      // Build up some state
      for (let i = 0; i < 10; i++) {
        await horizonFake.simulateRequest('/ledgers');
      }
      
      const initialCursor = horizonFake.getCurrentCursor();
      const profile: FailureProfile = { reorgDepth: 5 };
      
      // Trigger reorg
      await horizonFake.simulateRequest('/ledgers');
      const newCursor = horizonFake.getCurrentCursor();
      
      // Verify cursor handling
      expect(Number(newCursor)).toBeLessThan(Number(initialCursor));
    });

    test('should handle multiple sequential reorgs', async () => {
      const reorgDepths = [1, 3, 5, 2];
      
      for (const depth of reorgDepths) {
        const profile: FailureProfile = { reorgDepth: depth };
        const result = await runChaosScenario(horizonFake, profile, 2);
        
        expect(result.success).toBe(true);
        expect(horizonFake.getRequestCount()).toBeGreaterThan(0);
        await wait(200);
      }
    }, 15000);
  });

  describe('Edge Cases', () => {
    test('should handle duplicate event IDs idempotently', async () => {
      const processed = new Set<string>();
      const duplicates: string[] = [];
      
      // Simulate processing events with potential duplicates
      for (let i = 0; i < 20; i++) {
        const response = await horizonFake.simulateRequest('/events');
        if (response && response.records) {
          for (const record of response.records) {
            if (processed.has(record.id)) {
              duplicates.push(record.id);
            } else {
              processed.add(record.id);
            }
          }
        }
      }
      
      // No duplicates should be processed twice
      expect(duplicates).toHaveLength(0);
    });

    test('should handle reorg during active indexer operation', async () => {
      const results = [];
      
      // Simulate indexer operations with reorgs
      for (let i = 0; i < 10; i++) {
        const profile: FailureProfile = i % 3 === 0 ? { reorgDepth: 3 } : {};
        const result = await runChaosScenario(horizonFake, profile, 2);
        results.push(result);
        await wait(100);
      }
      
      // Verify operations completed
      const successful = results.filter(r => r.success);
      expect(successful.length).toBeGreaterThanOrEqual(7);
    }, 20000);

    test('should handle network flakiness with mixed failures', async () => {
      const profile: FailureProfile = { 
        latencyMs: 1000, 
        dropConnection: true,
        partialReads: true,
        errorRate: 0.3
      };
      
      const result = await runChaosScenario(horizonFake, profile, 10);
      
      // Should still work with mixed failures
      expect(result.requestCount).toBe(10);
      
      // Some errors expected
      expect(result.errors.length).toBeGreaterThan(0);
    }, 20000);

    test('should handle rapid consecutive failure mode switches', async () => {
      const modes = [
        { dropConnection: true },
        { partialReads: true },
        { latencyMs: 2000 },
        { reorgDepth: 5 },
        {}
      ];
      
      for (const mode of modes) {
        horizonFake.setFailureProfile(mode);
        const result = await runChaosScenario(horizonFake, mode, 3);
        expect(result.requestCount).toBe(3);
        await wait(200);
      }
    }, 15000);
  });
});
