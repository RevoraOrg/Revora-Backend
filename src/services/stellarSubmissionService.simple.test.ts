import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { StellarRPCFailureClass } from '../lib/stellarRpcFailure';
import { Errors } from '../lib/errors';

// Mock logger
jest.mock('../lib/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => logger),
  };
  return { globalLogger: logger };
});

// Mock environment. The secret is read live from process.env so tests can toggle
// it: the "missing secret" test deletes it, the remaining tests set it in setup.
jest.mock('../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_TIMEOUT: 30000,
    STELLAR_MAX_FEE: 100000,
    get STELLAR_SERVER_SECRET() {
      return process.env.STELLAR_SERVER_SECRET;
    },
  },
}));

// The real @stellar/stellar-sdk exposes `rpc.Server` as a non-configurable
// getter, so it cannot be reassigned. Mock the whole module so beforeEach can
// rewire the jest fns it needs.
jest.mock('@stellar/stellar-sdk', () => ({
  rpc: { Server: jest.fn() },
  Keypair: { fromSecret: jest.fn() },
  Asset: { native: jest.fn() },
  TransactionBuilder: jest.fn(),
  Operation: { payment: jest.fn(), invokeContractFunction: jest.fn() },
  BASE_FEE: '100',
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
}));

describe('StellarSubmissionService - Simple Tests', () => {
  let service: StellarSubmissionService;
  let mockServer: any;

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = 'SABERIntegrationTestSecretKey1234567890ABCDEF';
    jest.clearAllMocks();
    
    // Create fresh mocks for each test
    mockServer = {
      getAccount: jest.fn(),
      sendTransaction: jest.fn(),
    };

    // Use the module-mocked jest fns (the real SDK exposes read-only getters,
    // so these must be configured via mock implementations, not assignment).
    (StellarSdk.rpc.Server as jest.Mock).mockReturnValue(mockServer);
    (StellarSdk.Keypair.fromSecret as jest.Mock).mockReturnValue({
      publicKey: () => 'G-MOCK-PUBLIC-KEY',
      sign: jest.fn(),
    });
    (StellarSdk.Asset.native as jest.Mock).mockReturnValue({
      isNative: () => true,
      code: 'XLM',
      issuer: undefined,
    });

    const mockTransaction = {
      hash: () => 'mock-transaction-hash',
      sign: jest.fn(),
    };

    (StellarSdk.TransactionBuilder as jest.Mock).mockReturnValue({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue(mockTransaction),
    });

    service = new StellarSubmissionService();
  });

  it('should initialize successfully', () => {
    expect(service).toBeInstanceOf(StellarSubmissionService);
    expect(service.getPublicKey()).toBe('G-MOCK-PUBLIC-KEY');
  });

  it('should submit payment successfully', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    mockServer.sendTransaction.mockResolvedValue({
      hash: 'success-hash',
      status: 'PENDING',
      latestLedger: 12345,
      latestLedgerCloseTime: 1234567890,
    });

    const result = await service.submitPayment('G-DEST', '10.0');
    
    expect(result.hash).toBe('success-hash');
    expect(result.status).toBe('PENDING');
  });

  it('should handle insufficient funds error', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    const insufficientError = { code: 'INSUFFICIENT_FUNDS' };
    mockServer.sendTransaction.mockRejectedValue(insufficientError);

    const result = await service.submitPayment('G-DEST', '10.0').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.badRequest('test').constructor);
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toBe('Insufficient funds for payment');
  });

  it('should handle validation error', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    const validationError = { status: 400 };
    mockServer.sendTransaction.mockRejectedValue(validationError);

    const result = await service.submitPayment('invalid', 'invalid').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.validationError('test').constructor);
    expect(result.code).toBe('VALIDATION_ERROR');
    expect(result.message).toBe('Invalid payment parameters');
  });

  it('should handle timeout error', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    const timeoutError = new Error('Request timeout');
    timeoutError.name = 'AbortError';
    mockServer.sendTransaction.mockRejectedValue(timeoutError);

    const result = await service.submitPayment('G-DEST', '10.0').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.serviceUnavailable('test').constructor);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.message).toBe('Stellar network request timed out');
  });

  it('should handle rate limit error', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    const rateLimitError = { status: 429 };
    mockServer.sendTransaction.mockRejectedValue(rateLimitError);

    const result = await service.submitPayment('G-DEST', '10.0').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.serviceUnavailable('test').constructor);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.message).toBe('Stellar network rate limit exceeded');
  });

  it('should invoke contract successfully', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    mockServer.sendTransaction.mockResolvedValue({
      hash: 'contract-hash',
      status: 'PENDING',
      latestLedger: 12345,
      latestLedgerCloseTime: 1234567890,
    });

    const result = await service.invokeContract('contract-id', 'transfer', ['arg1']);
    
    expect(result.hash).toBe('contract-hash');
    expect(result.status).toBe('PENDING');
  });

  it('should handle contract execution error', async () => {
    mockServer.getAccount.mockResolvedValue({
      accountId: () => 'G-MOCK-PUBLIC-KEY',
      sequenceNumber: () => '1',
      incrementSequenceNumber: jest.fn(),
    });
    
    const contractError = { code: 'CONTRACT_ERROR' };
    mockServer.sendTransaction.mockRejectedValue(contractError);

    const result = await service.invokeContract('contract-id', 'transfer').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.badRequest('test').constructor);
    expect(result.code).toBe('BAD_REQUEST');
    expect(result.message).toBe('Contract execution failed');
  });

  it('should handle getAccount failure', async () => {
    const networkError = new Error('Network connection failed');
    networkError.name = 'NetworkError';
    mockServer.getAccount.mockRejectedValue(networkError);

    const result = await service.submitPayment('G-DEST', '10.0').catch(err => err);
    
    expect(result).toBeInstanceOf(Errors.serviceUnavailable('test').constructor);
    expect(result.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.message).toBe('Network connection to Stellar failed');
  });

  it('should throw error if secret is missing', () => {
    const originalSecret = process.env.STELLAR_SERVER_SECRET;
    delete process.env.STELLAR_SERVER_SECRET;
    
    expect(() => new StellarSubmissionService()).toThrow(
      'STELLAR_SERVER_SECRET is not defined in environment variables',
    );
    
    process.env.STELLAR_SERVER_SECRET = originalSecret;
  });

  it('should throw error if secret is invalid', () => {
    process.env.STELLAR_SERVER_SECRET = 'invalid-secret';
    (StellarSdk.Keypair.fromSecret as jest.Mock).mockImplementationOnce(() => {
      throw new Error('invalid secret');
    });

    expect(() => new StellarSubmissionService()).toThrow(
      'Invalid STELLAR_SERVER_SECRET provided',
    );
    
    // Restore valid secret
    process.env.STELLAR_SERVER_SECRET = 'SABERIntegrationTestSecretKey1234567890ABCDEF';
  });
});
