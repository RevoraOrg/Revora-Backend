import * as fc from 'fast-check';
import { Request } from 'express';
import {
  createStartupAuthTierLimiter,
  STARTUP_AUTH_RATE_TIER_HEADER,
  STARTUP_AUTH_TIER_SECRET_HEADER,
} from '../startupAuthRateTierPolicy';

function makeRequest(headers: Record<string, string> = {}): Request {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
  } as unknown as Request;
}

describe('resolveTier — property-based tests', () => {
  afterEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  // Property 3: Elevated tier requires exact secret match
  it('Property 3: Elevated tier requires exact secret match', () => {
    // Feature: rate-limiter-tier-policies, Property 3: Elevated tier requires exact secret match
    fc.assert(
      fc.property(
        fc.constantFrom('trusted' as const, 'internal' as const),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        (tier, configuredSecret, providedSecret) => {
          fc.pre(configuredSecret !== providedSecret);
          process.env.STARTUP_AUTH_TIER_SECRET = configuredSecret;
          const limiter = createStartupAuthTierLimiter();
          const req = makeRequest({
            [STARTUP_AUTH_RATE_TIER_HEADER]: tier,
            [STARTUP_AUTH_TIER_SECRET_HEADER]: providedSecret,
          });
          expect(limiter.resolveTier(req)).toBe('standard');
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 4: Unknown tier header always resolves to standard
  it('Property 4: Unknown tier header always resolves to standard', () => {
    // Feature: rate-limiter-tier-policies, Property 4: Unknown tier header always resolves to standard
    fc.assert(
      fc.property(
        fc.string(),
        fc.string({ minLength: 1 }),
        (tierValue, secret) => {
          fc.pre(tierValue !== 'trusted' && tierValue !== 'internal');
          process.env.STARTUP_AUTH_TIER_SECRET = secret;
          const limiter = createStartupAuthTierLimiter();
          const req = makeRequest({
            [STARTUP_AUTH_RATE_TIER_HEADER]: tierValue,
            [STARTUP_AUTH_TIER_SECRET_HEADER]: secret,
          });
          expect(limiter.resolveTier(req)).toBe('standard');
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 10: Configurable tier secret env var name
  it('Property 10: Configurable tier secret env var name', () => {
    // Feature: rate-limiter-tier-policies, Property 10: Configurable tier secret env var name
    fc.assert(
      fc.property(
        // Use a TEST_ prefix to avoid colliding with real env vars already set in the process
        fc.string({ minLength: 1, maxLength: 20 })
          .filter((s) => /^[A-Z0-9_]+$/.test(s))
          .map((s) => `TEST_TIER_SECRET_${s}`),
        // Secret must be non-empty after trimming (resolveTier trims before comparing)
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        fc.constantFrom('trusted' as const, 'internal' as const),
        (envName, secret, tier) => {
          process.env[envName] = secret;
          try {
            const limiter = createStartupAuthTierLimiter({ tierSecretEnvName: envName });
            const req = makeRequest({
              [STARTUP_AUTH_RATE_TIER_HEADER]: tier,
              [STARTUP_AUTH_TIER_SECRET_HEADER]: secret,
            });
            expect(limiter.resolveTier(req)).toBe(tier);
          } finally {
            delete process.env[envName];
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 11: Whitespace trimming on both secret sides
  it('Property 11: Whitespace trimming on both secret sides', () => {
    // Feature: rate-limiter-tier-policies, Property 11: Whitespace trimming on both secret sides
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => s.trim() === s && s.length > 0),
        fc.constantFrom('trusted' as const, 'internal' as const),
        (secret, tier) => {
          // Test 1: env var padded, header clean
          process.env.STARTUP_AUTH_TIER_SECRET = `  ${secret}  `;
          const limiter1 = createStartupAuthTierLimiter();
          const req1 = makeRequest({
            [STARTUP_AUTH_RATE_TIER_HEADER]: tier,
            [STARTUP_AUTH_TIER_SECRET_HEADER]: secret,
          });
          expect(limiter1.resolveTier(req1)).toBe(tier);

          // Test 2: env var clean, header padded
          process.env.STARTUP_AUTH_TIER_SECRET = secret;
          const limiter2 = createStartupAuthTierLimiter();
          const req2 = makeRequest({
            [STARTUP_AUTH_RATE_TIER_HEADER]: tier,
            [STARTUP_AUTH_TIER_SECRET_HEADER]: `  ${secret}  `,
          });
          expect(limiter2.resolveTier(req2)).toBe(tier);
        }
      ),
      { numRuns: 100 }
    );
  });
});
