/**
 * Tests for StellarSubmissionService.
 *
 * stellar-sdk is mocked via __mocks__/stellar-sdk.js (root-level manual mock)
 * so no real network calls are made and the package does not need to be
 * installed.
 */
import { StellarSubmissionService } from './stellarSubmissionService';

// Activates the manual mock in __mocks__/stellar-sdk.js
jest.mock('stellar-sdk');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const StellarSdk = require('stellar-sdk');

describe('StellarSubmissionService', () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    // ── Constructor ────────────────────────────────────────────────────────────
    describe('constructor', () => {
        it('throws when STELLAR_SERVER_SECRET is not set', () => {
            delete process.env.STELLAR_SERVER_SECRET;
            expect(() => new StellarSubmissionService()).toThrow(
                'STELLAR_SERVER_SECRET is not configured.'
            );
        });

        it('constructs successfully when STELLAR_SERVER_SECRET is set', () => {
            process.env.STELLAR_SERVER_SECRET = 'SMOCK_SECRET';
            const svc = new StellarSubmissionService();
            expect(svc).toBeDefined();
            expect(StellarSdk.Keypair.fromSecret).toHaveBeenCalledWith('SMOCK_SECRET');
        });
    });

    // ── submitPayment ──────────────────────────────────────────────────────────
    describe('submitPayment', () => {
        let svc: StellarSubmissionService;

        beforeEach(() => {
            process.env.STELLAR_SERVER_SECRET = 'SMOCK_SECRET';
            svc = new StellarSubmissionService();
        });

        it('calls Operation.payment with correct args and returns the result', async () => {
            const result = await svc.submitPayment('GFROM...', 'GTO...', '10.5');

            expect(StellarSdk.Operation.payment).toHaveBeenCalledWith({
                source: 'GFROM...',
                destination: 'GTO...',
                asset: 'native',
                amount: '10.5',
            });
            expect(result).toEqual({ successful: true, hash: 'mock-tx-hash' });
        });

        it('accepts a custom asset', async () => {
            const usdcAsset = { code: 'USDC', issuer: 'GISSUER' };
            await svc.submitPayment('GFROM...', 'GTO...', '5', usdcAsset);

            expect(StellarSdk.Operation.payment).toHaveBeenCalledWith(
                expect.objectContaining({ asset: usdcAsset })
            );
        });
    });

    // ── invokeContract ─────────────────────────────────────────────────────────
    describe('invokeContract', () => {
        let svc: StellarSubmissionService;

        beforeEach(() => {
            process.env.STELLAR_SERVER_SECRET = 'SMOCK_SECRET';
            svc = new StellarSubmissionService();
        });

        it('calls Operation.invokeHostFunction and returns the result', async () => {
            const result = await svc.invokeContract('CCONTRACT...', 'distribute', []);

            expect(StellarSdk.Operation.invokeHostFunction).toHaveBeenCalled();
            expect(result).toEqual({ successful: true, hash: 'mock-tx-hash' });
        });
    });

    // ── submitOperation ────────────────────────────────────────────────────────
    describe('submitOperation', () => {
        let svc: StellarSubmissionService;

        beforeEach(() => {
            process.env.STELLAR_SERVER_SECRET = 'SMOCK_SECRET';
            svc = new StellarSubmissionService();
        });

        it('adds the provided operation and submits', async () => {
            const op = { type: 'arbitrary' };
            const result = await svc.submitOperation(op);

            expect(result).toEqual({ successful: true, hash: 'mock-tx-hash' });
        });
    });
});
