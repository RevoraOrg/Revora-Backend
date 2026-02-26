import { StellarSubmissionService } from './stellarSubmissionService';
import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';

// Mock @stellar/stellar-sdk
jest.mock('@stellar/stellar-sdk', () => {
    return {
        rpc: {
            Server: jest.fn().mockImplementation(() => ({
                getAccount: jest.fn().mockResolvedValue({
                    sequenceNumber: () => '1',
                    incrementSequenceNumber: jest.fn(),
                }),
                sendTransaction: jest.fn().mockResolvedValue({ hash: 'mock-hash', status: 'SUCCESS' }),
            })),
        },
        Keypair: {
            fromSecret: jest.fn().mockReturnValue({
                publicKey: () => 'G-MOCK-PUBLIC-KEY',
                sign: jest.fn(),
            }),
        },
        Asset: {
            native: jest.fn().mockReturnValue({ code: 'XLM', issuer: undefined }),
        },
        TransactionBuilder: jest.fn().mockImplementation(() => ({
            addOperation: jest.fn().mockReturnThis(),
            setTimeout: jest.fn().mockReturnThis(),
            build: jest.fn().mockReturnThis(),
            sign: jest.fn(),
        })),
        Operation: {
            payment: jest.fn(),
        },
        BASE_FEE: '100',
        Networks: {
            TESTNET: 'Test SDF Network ; September 2015',
            PUBLIC: 'Public Global Stellar Network ; October 2015',
        },
    };
});

describe('StellarSubmissionService', () => {
    let service: StellarSubmissionService;
    const mockSecret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    beforeEach(() => {
        process.env.STELLAR_SERVER_SECRET = mockSecret;
        jest.clearAllMocks();
        service = new StellarSubmissionService();
    });

    it('should initialize with the correct horizon URL and keypair', () => {
        expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith(mockSecret);
        expect(StellarSdk.rpc.Server).toHaveBeenCalled();
    });

    it('should throw error if secret is missing', () => {
        const originalSecret = process.env.STELLAR_SERVER_SECRET;
        delete process.env.STELLAR_SERVER_SECRET;
        expect(() => new StellarSubmissionService()).toThrow('STELLAR_SERVER_SECRET is not defined');
        process.env.STELLAR_SERVER_SECRET = originalSecret;
    });

    it('should submit a payment successfully', async () => {
        const to = 'G-DESTINATION';
        const amount = '10.0';

        await service.submitPayment(to, amount);

        expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
            destination: to,
            amount: amount,
            asset: expect.anything(),
        });
        expect(StellarSdk.TransactionBuilder).toHaveBeenCalled();
    });

    it('should return the public key', () => {
        expect(service.getPublicKey()).toBe('G-MOCK-PUBLIC-KEY');
    });
});
