import * as fc from 'fast-check';
import { InMemoryRateLimitStore } from '../rateLimit';

describe('InMemoryRateLimitStore — property-based tests', () => {
  // Property 1: Fixed-window counter is deterministic
  it('Property 1: Fixed-window counter is deterministic', () => {
    // Feature: rate-limiter-tier-policies, Property 1: Fixed-window counter is deterministic
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 25 }), (n) => {
        const store = new InMemoryRateLimitStore();
        let lastResetAt: number | undefined;
        for (let i = 0; i < n; i++) {
          const { count, resetAt } = store.increment('key', 60_000);
          expect(count).toBe(i + 1);
          if (lastResetAt !== undefined) expect(resetAt).toBe(lastResetAt);
          lastResetAt = resetAt;
        }
      }),
      { numRuns: 100 }
    );
  });

  // Property 8: Window expiry resets the counter to 1
  it('Property 8: Window expiry resets the counter to 1', async () => {
    // Feature: rate-limiter-tier-policies, Property 8: Window expiry resets the counter to 1
    // Use a 1ms window; increment once; wait >1ms; increment again; assert count === 1 and new resetAt > old resetAt
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
        const store = new InMemoryRateLimitStore();
        // Increment n times in a 1ms window
        let firstResetAt: number | undefined;
        for (let i = 0; i < n; i++) {
          const { resetAt } = store.increment('expiry-key', 1);
          if (firstResetAt === undefined) firstResetAt = resetAt;
        }
        // Wait for the window to expire
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Next increment should start a fresh window
        const { count, resetAt: newResetAt } = store.increment('expiry-key', 60_000);
        expect(count).toBe(1);
        expect(newResetAt).toBeGreaterThan(firstResetAt!);
      }),
      { numRuns: 10 } // fewer runs since each involves a real setTimeout
    );
  });
});
