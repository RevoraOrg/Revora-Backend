import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';

/**
 * Service for building and submitting Stellar transactions.
 */
export class StellarSubmissionService {
  private server: StellarSdk.rpc.Server;
  private keypair: StellarSdk.Keypair;

  constructor() {
    const horizonUrl =
      env.STELLAR_HORIZON_URL ||
      (env.STELLAR_NETWORK === 'public'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org');

    this.server = new StellarSdk.rpc.Server(horizonUrl);

    const secret = process.env.STELLAR_SERVER_SECRET;
    if (!secret) {
      throw new Error('STELLAR_SERVER_SECRET is not defined in environment variables');
    }

    try {
      this.keypair = StellarSdk.Keypair.fromSecret(secret);
    } catch {
      throw new Error('Invalid STELLAR_SERVER_SECRET provided');
    }
  }

  /**
   * Submits a simple payment transaction.
   * @param to Destination public key
   * @param amount Amount to send (as string)
   * @param asset Asset to send (defaults to native XLM)
   * @returns Transaction result
   */
  async submitPayment(
    to: string,
    amount: string,
    asset: StellarSdk.Asset = StellarSdk.Asset.native(),
  ) {
    const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase:
        env.STELLAR_NETWORK_PASSPHRASE ||
        (env.STELLAR_NETWORK === 'public'
          ? StellarSdk.Networks.PUBLIC
          : StellarSdk.Networks.TESTNET),
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: to,
          asset,
          amount,
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(this.keypair);

    return this.server.sendTransaction(transaction);
  }

  /**
   * Invokes a Soroban contract (placeholder for logic).
   */
  async invokeContract(
    _contractId: string,
    _functionName: string,
    _args: any[] = [],
  ): Promise<never> {
    void _contractId;
    void _functionName;
    void _args;
    throw new Error('Soroban contract invocation not fully implemented yet');
  }

  /**
   * Gets the public key of the service's keypair.
   */
  getPublicKey(): string {
    return this.keypair.publicKey();
  }
}
