import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarSubmissionService } from '../../services/stellarSubmissionService';
import { globalMetrics } from '../../lib/metrics';

// Mock logger
jest.mock('../../lib/logger', () => ({
  globalLogger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  },
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
  }
}));

// Mock environment
jest.mock('../../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    STELLAR_SERVER_SECRET: 'SABERIntegrationTestSecretKey1234567890ABCDEF',
  },
}));

describe('Horizon Duplicate Hash Chaos Tests', () => {
  let service: StellarSubmissionService;
  let mockServer: any;
  let metricsIncrementSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.STELLAR_SERVER_SECRET = 'SABERIntegrationTestSecretKey1234567890ABCDEF';
    jest.clearAllMocks();
    
    metricsIncrementSpy = jest.spyOn(globalMetrics, 'increment');
    
    mockServer = {
      getAccount: jest.fn().mockResolvedValue({
        accountId: () => 'G-MOCK-PUBLIC-KEY',
        sequenceNumber: () => '1',
        incrementSequenceNumber: jest.fn(),
      }),
      sendTransaction: jest.fn(),
    };
    
    StellarSdk.rpc.Server = jest.fn(() => mockServer) as any;
    StellarSdk.Keypair.fromSecret = jest.fn(() => ({
      publicKey: () => 'G-MOCK-PUBLIC-KEY',
      sign: jest.fn(),
    })) as any;
    
    StellarSdk.Asset.native = jest.fn(() => ({ code: 'XLM', issuer: undefined })) as any;
    
    StellarSdk.TransactionBuilder = jest.fn(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        hash: () => Buffer.from('mock-hash'),
        sign: jest.fn(),
      }),
    })) as any;
    
    StellarSdk.Operation.payment = jest.fn() as any;
    (StellarSdk as any).BASE_FEE = '100';
    
    service = new StellarSubmissionService();
  });

  afterEach(() => {
    metricsIncrementSpy.mockRestore();
  });

  it('should treat first-attempt duplicate as success (retry recovery scenario)', async () => {
    mockServer.sendTransaction.mockResolvedValueOnce({
      hash: 'mock-hash',
      status: 'DUPLICATE',
      latestLedger: 12345,
      latestLedgerCloseTime: 1234567890,
    });

    const result = await service.submitPayment('G-DEST', '10.0');

    expect(result.status).toBe('DUPLICATE');
    expect(metricsIncrementSpy).toHaveBeenCalledWith('submission.duplicate.recovered', 1);
  });

  it('should treat true-duplicate as success without double persisting (client bug)', async () => {
    mockServer.sendTransaction.mockResolvedValueOnce({
      hash: 'mock-hash',
      status: 'DUPLICATE',
      latestLedger: 12345,
      latestLedgerCloseTime: 1234567890,
    });

    const result = await service.submitPayment('G-DEST', '10.0');

    expect(result.status).toBe('DUPLICATE');
    expect(metricsIncrementSpy).toHaveBeenCalledWith('submission.duplicate.recovered', 1);
    
    expect(result).toBeDefined();
    
    expect(service.getTransactionCacheSize()).toBe(1);
  });

  it('Concurrent duplicate submissions from two workers coalesce', async () => {
    mockServer.sendTransaction
      .mockResolvedValueOnce({
        hash: 'mock-hash',
        status: 'PENDING',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      })
      .mockResolvedValueOnce({
        hash: 'mock-hash',
        status: 'DUPLICATE',
        latestLedger: 12345,
        latestLedgerCloseTime: 1234567890,
      });

    const worker1 = service;
    const worker2 = new StellarSubmissionService();

    const [res1, res2] = await Promise.all([
      worker1.submitPayment('G-DEST', '10.0'),
      worker2.submitPayment('G-DEST', '10.0'),
    ]);

    expect(res1.status).toBe('PENDING');
    expect(res2.status).toBe('DUPLICATE');

    expect(metricsIncrementSpy).toHaveBeenCalledWith('submission.duplicate.recovered', 1);
    
    expect(res1).toBeDefined();
    expect(res2).toBeDefined();
  });
});
