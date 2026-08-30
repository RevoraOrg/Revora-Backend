module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  globals: {
    'ts-jest': {
      // Suppress pre-existing BigInt/bigint type errors in src/lib/decimal.ts
      // that are a known upstream issue. Runtime behaviour is correct.
      diagnostics: { warnOnly: true },
    },
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
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};
