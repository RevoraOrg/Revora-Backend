/**
 * Manual Jest mock for stellar-sdk.
 *
 * Placed in <root>/__mocks__/stellar-sdk.js so that Jest automatically picks
 * it up whenever a test calls  jest.mock('stellar-sdk').
 * This allows tests to run without the real package being installed.
 */

const mockSubmitTransaction = jest.fn().mockResolvedValue({
    successful: true,
    hash: 'mock-tx-hash',
});

const mockLoadAccount = jest.fn().mockResolvedValue({ id: 'GBX_MOCK' });

const mockTransactionBuilder = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({ sign: jest.fn() }),
}));

const stellar = {
    Server: jest.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
    })),

    Keypair: {
        fromSecret: jest.fn().mockReturnValue({
            publicKey: jest.fn().mockReturnValue('GBX_SERVER_PUB'),
            sign: jest.fn(),
        }),
    },

    TransactionBuilder: mockTransactionBuilder,

    Operation: {
        payment: jest.fn().mockReturnValue({ type: 'payment' }),
        invokeHostFunction: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
    },

    Asset: {
        native: jest.fn().mockReturnValue('native'),
    },

    BASE_FEE: '100',

    Networks: {
        TESTNET: 'Test SDF Network ; September 2015',
        PUBLIC: 'Public Global Stellar Network ; September 2015',
    },

    xdr: {
        HostFunction: {
            hostFunctionTypeInvokeContract: jest.fn().mockReturnValue({}),
        },
        InvokeContractArgs: jest.fn().mockImplementation(() => ({})),
    },

    Address: {
        fromString: jest.fn().mockReturnValue({
            toScAddress: jest.fn().mockReturnValue({}),
        }),
    },
};

module.exports = stellar;
