import fs from 'fs';
import path from 'path';

interface JestConfigShape {
  collectCoverageFrom?: string[];
  coverageThreshold?: {
    global?: {
      branches?: number;
      functions?: number;
      lines?: number;
      statements?: number;
    };
  };
}

const ROOT_DIR = path.resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jestConfig = require(path.join(ROOT_DIR, 'jest.config.js')) as JestConfigShape;

const REQUIRED_SECURITY_MODULES = [
  'src/middleware/auth.ts',
  'src/middleware/authWithSession.ts',
  'src/middleware/adminSignature.ts',
  'src/middleware/deviceSignature.ts',
  'src/middleware/webhookAuth.ts',
  'src/middleware/scimAuth.ts',
  'src/lib/jwt.ts',
  'src/lib/webhookSignature.ts',
  'src/lib/ssrfProtection.ts',
  'src/services/accountingLedgerService.ts',
  'src/services/ledgerService.ts',
  'src/db/repositories/ledgerEntryRepository.ts',
  'src/db/repositories/ledgerPeriodLockRepository.ts',
  'src/db/repositories/disputeLedgerEventRepository.ts',
];

const EXISTING_BASELINE_MODULES = [
  'src/routes/offerings.investments.ts',
  'src/lib/pressureGauge.ts',
  'src/services/outboxDispatcher.ts',
  'src/lib/metrics.ts',
  'src/db/repositories/scheduledDistributionRepository.ts',
];

describe('jest.config.js coverage gate configuration', () => {
  it('includes all required security-critical modules in collectCoverageFrom', () => {
    const collectCoverageFrom = jestConfig.collectCoverageFrom ?? [];
    for (const modulePath of REQUIRED_SECURITY_MODULES) {
      expect(collectCoverageFrom).toContain(modulePath);
    }
  });

  it('retains all baseline modules in collectCoverageFrom', () => {
    const collectCoverageFrom = jestConfig.collectCoverageFrom ?? [];
    for (const modulePath of EXISTING_BASELINE_MODULES) {
      expect(collectCoverageFrom).toContain(modulePath);
    }
  });

  it('lists only existing files in collectCoverageFrom without duplicates', () => {
    const collectCoverageFrom = jestConfig.collectCoverageFrom ?? [];
    expect(new Set(collectCoverageFrom).size).toBe(collectCoverageFrom.length);
    for (const modulePath of collectCoverageFrom) {
      const fullPath = path.join(ROOT_DIR, modulePath);
      expect(fs.existsSync(fullPath)).toBe(true);
    }
  });

  it('defines positive global coverage thresholds for all four metrics', () => {
    const globalThreshold = jestConfig.coverageThreshold?.global;
    expect(globalThreshold).toBeDefined();
    for (const metric of ['branches', 'functions', 'lines', 'statements'] as const) {
      const value = globalThreshold?.[metric];
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
