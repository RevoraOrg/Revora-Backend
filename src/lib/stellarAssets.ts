import { env } from '../config/env';

export type StellarAssetConfig = {
  code: string;
  issuer: string;
};

/**
 * Official USDC issuers on Stellar
 * public = mainnet
 */
const USDC_ASSETS: Record<'testnet' | 'public', StellarAssetConfig> = {
  testnet: {
    code: 'USDC',
    issuer: 'GBBD47IFXTEOQW2KJZQW6NQYH3H7O5YB7VZC2Q5RZUSDC_TESTNET',
  },
  public: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37ZREPLACE_WITH_MAINNET_ISSUER',
  },
};

/**
 * Returns USDC configuration for current network
 */
export function getUSDCAssetConfig(): StellarAssetConfig {
  const network = env.STELLAR_NETWORK;

  const asset = USDC_ASSETS[network];

  if (!asset) {
    throw new Error(`Unsupported Stellar network: ${network}`);
  }

  return asset;
}

/**
 * Validates whether given asset matches configured USDC
 */
export function isUSDCAsset(
  assetCode: string,
  assetIssuer: string
): boolean {
  const { code, issuer } = getUSDCAssetConfig();

  return assetCode === code && assetIssuer === issuer;
}