import * as StellarSdk from 'stellar-sdk';
import { StellarSubmissionService } from './stellarSubmissionService';
import { env } from '../config/env';

// Mock stellar-sdk
jest.mock('stellar-sdk', () => {
  const mockKeypair = {
    publicKey: jest.fn().mockReturnValue('GBMOCKPUBLICKEY'),
    fromSecret: jest.fn().mockReturnValue({ publicKey: () => 'GBMOCKPUBLICKEY' }),
  };
  
  const mockServer = {
    loadAccount: jest.fn().mockResolvedValue({
      sequenceNumber: () => '123',
      incrementSequenceNumber: jest.fn(),
    }),
    submitTransaction: jest.fn().mockResolvedValue({ hash: 'mock_tx_hash' }),
  };

  const mockTransaction = {
    sign: jest.fn(),
  };

  const mockTransactionBuilder = jest.fn().mockReturnValue({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mockTransaction),
  });

  return {
    Horizon: {
      Server: jest.fn().mockImplementation(() => mockServer),
    },
    Keypair: mockKeypair,
    TransactionBuilder: mockTransactionBuilder,
    Operation: {
      payment: jest.fn().mockReturnValue({}),
    },
    Asset: {
      native: jest.fn().mockReturnValue({}),
    },
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; October 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    BASE_FEE: '100',
  };
});

// Mock config/env
jest.mock('../config/env', () => ({
  env: {
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  },
}));

describe('StellarSubmissionService', () => {
  let service: StellarSubmissionService;
  const originalSecret = process.env.STELLAR_SERVER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STELLAR_SERVER_SECRET = 'SDMOCKSECRETKEY';
    service = new StellarSubmissionService();
  });

  afterAll(() => {
    process.env.STELLAR_SERVER_SECRET = originalSecret;
  });

  it('should initialize with correct horizon URL and network passphrase', () => {
    expect(StellarSdk.Horizon.Server).toHaveBeenCalledWith('https://horizon-testnet.stellar.org');
    expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith('SDMOCKSECRETKEY');
  });

  it('should throw error if STELLAR_SERVER_SECRET is missing', () => {
    delete process.env.STELLAR_SERVER_SECRET;
    expect(() => new StellarSubmissionService()).toThrow('STELLAR_SERVER_SECRET environment variable is not set');
  });

  it('should build and submit a payment transaction', async () => {
    const to = 'GDOCKDESTINATION';
    const amount = '100.0';
    
    const result = await service.submitPayment(to, amount);
    
    expect(result).toEqual({ hash: 'mock_tx_hash' });
    expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
      destination: to,
      amount: amount,
      asset: expect.anything(),
    });
    expect(StellarSdk.TransactionBuilder).toHaveBeenCalled();
  });

  it('should throw error on invokeContract as it is a placeholder', async () => {
    await expect(service.invokeContract('CID', 'func')).rejects.toThrow('Soroban contract invocation not fully implemented yet');
  });
});
