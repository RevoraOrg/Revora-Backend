import { createPayoutDriftDetector } from './index';
import { createStellarTransactionVerifier } from './lib/stellarTransactionVerifier';
import { MetricsCollector } from './lib/metrics';
import { PayoutDriftRepository } from './db/repositories/payoutDriftRepository';

jest.mock('./lib/stellarTransactionVerifier', () => ({
  createStellarTransactionVerifier: jest.fn(),
}));

const mockCreateVerifier = createStellarTransactionVerifier as jest.MockedFunction<
  typeof createStellarTransactionVerifier
>;

describe('payout drift bootstrap (issue #1302)', () => {
  const origHorizon = process.env.STELLAR_HORIZON_URL;

  afterEach(() => {
    if (origHorizon === undefined) {
      delete process.env.STELLAR_HORIZON_URL;
    } else {
      process.env.STELLAR_HORIZON_URL = origHorizon;
    }
    jest.clearAllMocks();
  });

  it('injects a StellarTransactionVerifier when STELLAR_HORIZON_URL is configured', () => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    mockCreateVerifier.mockReturnValue({
      verifyTransaction: jest.fn().mockResolvedValue({
        isValid: true,
        actualAmount: '0',
      }),
    } as any);

    const pool = {} as any;
    const repo = new PayoutDriftRepository(pool);
    const metrics = new MetricsCollector({ enabled: true });

    const detector = createPayoutDriftDetector(pool, repo, metrics);

    expect(mockCreateVerifier).toHaveBeenCalled();
    expect(detector).toBeInstanceOf(require('./services/payoutDriftDetector').PayoutDriftDetector);
  });

  it('does not inject a verifier and leaves gauge disabled when not configured', () => {
    delete process.env.STELLAR_HORIZON_URL;
    mockCreateVerifier.mockClear();

    const pool = {} as any;
    const repo = new PayoutDriftRepository(pool);
    const metrics = new MetricsCollector({ enabled: true });

    const detector = createPayoutDriftDetector(pool, repo, metrics);

    expect(mockCreateVerifier).not.toHaveBeenCalled();
    expect(detector).toBeDefined();
  });
});
