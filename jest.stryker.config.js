module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/lib/jwt.test.ts',
    '**/lib/webhookSignature.test.ts',
    '**/middleware/webhookAuth.test.ts',
  ],
  globals: {
    'ts-jest': {
      diagnostics: { warnOnly: true },
    },
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\\\.ts$': 'ts-jest',
  },
};
