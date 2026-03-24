/**
 * @title Jest Setup for Validation Matrix Tests
 * @dev Global test configuration and mocking
 * 
 * This file sets up global test environment including:
 * - Database mocking to prevent PostgreSQL connection attempts
 * - Environment variable setup
 * - Global test utilities
 */

// Mock database connections to prevent CI failures
jest.mock('pg', () => ({
  Pool: jest.fn(() => ({
    connect: jest.fn(() => ({
      query: jest.fn(() => Promise.resolve({ rows: [] })),
      release: jest.fn(),
    })),
    end: jest.fn(),
  })),
  Client: jest.fn(() => ({
    connect: jest.fn(),
    query: jest.fn(() => Promise.resolve({ rows: [] })),
    end: jest.fn(),
  })),
}));

// Mock Stellar SDK to prevent network calls
jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'testnet',
    PUBLIC: 'public',
  },
  Horizon: {
    Server: jest.fn(() => ({
      loadAccount: jest.fn(() => Promise.resolve({
        account_id: 'TEST_ACCOUNT_ID',
        sequence: 1,
      })),
      transactions: jest.fn(() => ({
        submit: jest.fn(() => Promise.resolve({
          hash: 'TEST_TX_HASH',
          ledger: 1,
        })),
      })),
    }),
  },
  Keypair: {
    random: jest.fn(() => ({
      publicKey: 'TEST_PUBLIC_KEY',
      secret: 'TEST_SECRET_KEY',
    })),
    fromSecret: jest.fn(() => ({
      publicKey: 'TEST_PUBLIC_KEY',
      secret: 'TEST_SECRET_KEY',
    })),
  },
}));

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.STELLAR_NETWORK = 'testnet';

// Global test timeout
jest.setTimeout(10000);

// Suppress console warnings in tests
const originalWarn = console.warn;
console.warn = (...args) => {
  if (args[0] && typeof args[0] === 'string' && args[0].includes('deprecated')) {
    return;
  }
  originalWarn(...args);
};

// Global test utilities
global.createMockUser = (overrides = {}) => ({
  id: 'test-user-id',
  email: 'test@example.com',
  role: 'startup',
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

global.createMockOffering = (overrides = {}) => ({
  id: 'test-offering-id',
  name: 'Test Offering',
  description: 'A test offering',
  revenue_share_bps: 1000,
  token_asset_id: 'TESTTOKEN',
  status: 'draft',
  issuer_user_id: 'test-user-id',
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

global.createMockContext = (overrides = {}) => ({
  user: global.createMockUser(),
  requestPayload: { requestId: 'test-123' },
  operation: 'create',
  offeringData: global.createMockOffering(),
  ...overrides,
});
