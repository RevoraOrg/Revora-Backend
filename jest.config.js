module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    'scripts/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.d.ts',
    '!src/__tests__/**/*',
    '!scripts/**/*.test.ts',
    '!scripts/fixtures/**/*',
    '!scripts/check-postmortem.ts',
    '!scripts/indexer-replay.ts',
    '!scripts/rbac-policy-diff.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 95,
      functions: 95,
      lines: 95,
      statements: 95,
    },
  },
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};
