// Helper functions for chaos testing
import { HorizonFake, FailureProfile } from '../mocks/horizonFake';

export interface TestResult {
  success: boolean;
  errors: Error[];
  requestCount: number;
  latency: number;
  cursor?: string;
}

export async function runChaosScenario(
  horizonFake: HorizonFake,
  profile: FailureProfile,
  operations: number,
  timeout: number = 30000
): Promise<TestResult> {
  const errors: Error[] = [];
  const startTime = Date.now();
  
  horizonFake.setFailureProfile(profile);

  try {
    // Simulate operations
    const promises = [];
    for (let i = 0; i < operations; i++) {
      promises.push(
        horizonFake.simulateRequest('/ledgers')
          .catch(error => {
            errors.push(error);
            return null;
          })
      );
    }

    await Promise.allSettled(promises);
    
    // Check if operations completed within timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeout) {
      throw new Error(`Operations exceeded timeout of ${timeout}ms`);
    }

    return {
      success: errors.length === 0,
      errors,
      requestCount: horizonFake.getRequestCount(),
      latency: elapsed,
      cursor: horizonFake.getCurrentCursor()
    };
  } catch (error) {
    return {
      success: false,
      errors: [...errors, error as Error],
      requestCount: horizonFake.getRequestCount(),
      latency: Date.now() - startTime
    };
  }
}

export function createSequentialProfile(duration: number): FailureProfile[] {
  const profiles: FailureProfile[] = [];
  
  // Create sequence of failure profiles
  const stages = [
    { latencyMs: 100, duration: 0.2 },
    { latencyMs: 1000, duration: 0.3 },
    { latencyMs: 5000, duration: 0.2 },
    { latencyMs: 100, duration: 0.3 }
  ];

  for (const stage of stages) {
    profiles.push({
      latencyMs: stage.latencyMs
    });
  }

  return profiles;
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
