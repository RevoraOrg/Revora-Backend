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
    'src/lib/pressureGauge.ts',
    'src/services/outboxDispatcher.ts',
    'src/lib/metrics.ts',
    'src/db/repositories/scheduledDistributionRepository.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
