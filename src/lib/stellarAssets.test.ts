import { env } from '../config/env';
import {
  getUSDCAssetConfig,
  isUSDCAsset,
} from './stellarAssets';

describe('stellarAssets', () => {
  const originalNetwork = env.STELLAR_NETWORK;

  afterEach(() => {
    env.STELLAR_NETWORK = originalNetwork;
  });

  describe('getUSDCAssetConfig', () => {
    it('returns the configured USDC asset for the public network', () => {
      env.STELLAR_NETWORK = 'public';

      expect(getUSDCAssetConfig()).toEqual({
        code: 'USDC',
        issuer: 'GA5ZSEJYB37ZREPLACE_WITH_MAINNET_ISSUER',
      });
    });

    it('returns the configured USDC asset for the testnet network', () => {
      env.STELLAR_NETWORK = 'testnet';

      expect(getUSDCAssetConfig()).toEqual({
        code: 'USDC',
        issuer: 'GBBD47IFXTEOQW2KJZQW6NQYH3H7O5YB7VZC2Q5RZUSDC_TESTNET',
      });
    });

    it('throws a deterministic error when the network is unsupported', () => {
      env.STELLAR_NETWORK = 'invalid-network' as any;

      expect(() => getUSDCAssetConfig()).toThrow(
        'Unsupported Stellar network: invalid-network'
      );
    });
  });

  describe('isUSDCAsset', () => {
    it('returns true only when both the asset code and issuer match the active network configuration', () => {
      env.STELLAR_NETWORK = 'testnet';

      expect(
        isUSDCAsset('USDC', 'GBBD47IFXTEOQW2KJZQW6NQYH3H7O5YB7VZC2Q5RZUSDC_TESTNET')
      ).toBe(true);
      expect(
        isUSDCAsset('USDC', 'GA5ZSEJYB37ZREPLACE_WITH_MAINNET_ISSUER')
      ).toBe(false);
      expect(
        isUSDCAsset('EURC', 'GBBD47IFXTEOQW2KJZQW6NQYH3H7O5YB7VZC2Q5RZUSDC_TESTNET')
      ).toBe(false);
    });
  });
});
