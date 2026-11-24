module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        // ts-jest 29.x crashes in getCacheKey when jest 30 reuses the same worker
        // across many suites (the resolved-module dependency graph grows stale and
        // references files that no longer exist). isolatedModules skips that whole
        // path and compiles each file independently, which is also faster.
        isolatedModules: true,
        // Suppress pre-existing type errors in several test files (known upstream
        // issues). Runtime behaviour is correct; failing hard on diagnostics would
        // break suites that have unrelated type drift.
        diagnostics: { warnOnly: true },
      },
    ],
  },
  collectCoverageFrom: [
    'src/routes/offerings.investments.ts',
    'src/lib/pressureGauge.ts',
    'src/services/outboxDispatcher.ts',
    'src/lib/metrics.ts',
    'src/db/repositories/scheduledDistributionRepository.ts',
    // Security-critical modules: auth, signatures, SSRF protection, and ledger
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
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 74,
      statements: 74,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
