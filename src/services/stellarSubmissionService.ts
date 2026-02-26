import * as StellarSdk from 'stellar-sdk';
import { env } from '../config/env';

/**
 * StellarSubmissionService handles building and submitting transactions to the Stellar network.
 * It uses the server's secret key for signing.
 */
export class StellarSubmissionService {
  private server: StellarSdk.Horizon.Server;
  private keypair: StellarSdk.Keypair;
  private networkPassphrase: string;

  constructor() {
    const horizonUrl = env.STELLAR_HORIZON_URL || (env.STELLAR_NETWORK === 'public' 
      ? 'https://horizon.stellar.org' 
      : 'https://horizon-testnet.stellar.org');
    
    this.server = new StellarSdk.Horizon.Server(horizonUrl);
    
    const secret = process.env.STELLAR_SERVER_SECRET;
    if (!secret) {
      throw new Error('STELLAR_SERVER_SECRET environment variable is not set');
    }
    this.keypair = StellarSdk.Keypair.fromSecret(secret);
    
    this.networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE || (env.STELLAR_NETWORK === 'public'
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET);
  }

  /**
   * Submits a simple payment transaction.
   * @param to Destination Stellar address.
   * @param amount Amount to send (in string format).
   * @param asset Asset to send (defaults to native XLM).
   */
  async submitPayment(to: string, amount: string, asset: StellarSdk.Asset = StellarSdk.Asset.native()): Promise<StellarSdk.Horizon.SubmitTransactionResponse> {
    try {
      const account = await this.server.loadAccount(this.keypair.publicKey());
      
      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: to,
          asset,
          amount,
        }))
        .setTimeout(30)
        .build();

      transaction.sign(this.keypair);
      
      return await this.server.submitTransaction(transaction);
    } catch (error) {
      console.error('Error submitting Stellar payment:', error);
      throw error;
    }
  }

  /**
   * Placeholder for invoking a Soroban contract.
   * Soroban support in stellar-sdk (v11+) involves more complex setup, 
   * but this follows the requested pattern.
   */
  async invokeContract(contractId: string, functionName: string, args: any[] = []): Promise<any> {
    // This is a placeholder for Soroban contract invocation logic.
    // In a full implementation, this would involve building a Transaction with an InvokeHostFunction operation.
    console.log(`Invoking contract ${contractId} function ${functionName} with args:`, args);
    throw new Error('Soroban contract invocation not fully implemented yet');
  }
}

export default new StellarSubmissionService();
