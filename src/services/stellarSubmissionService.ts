import * as StellarSdk from '@stellar/stellar-sdk';
import { env } from '../config/env';

/**
 * Service for building and submitting Stellar transactions.
 */
export class StellarSubmissionService {
    private server: StellarSdk.rpc.Server;
    private keypair: StellarSdk.Keypair;

    constructor() {
        const horizonUrl = env.STELLAR_HORIZON_URL || (env.STELLAR_NETWORK === 'public'
            ? 'https://horizon.stellar.org'
            : 'https://horizon-testnet.stellar.org');

        this.server = new StellarSdk.rpc.Server(horizonUrl);

        const secret = process.env.STELLAR_SERVER_SECRET;
        if (!secret) {
            throw new Error('STELLAR_SERVER_SECRET is not defined in environment variables');
        }

        try {
            this.keypair = StellarSdk.Keypair.fromSecret(secret);
        } catch (error) {
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
        asset: StellarSdk.Asset = StellarSdk.Asset.native()
    ) {
        const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

        const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || (env.STELLAR_NETWORK === 'public'
                ? StellarSdk.Networks.PUBLIC
                : StellarSdk.Networks.TESTNET),
        })
            .addOperation(StellarSdk.Operation.payment({
                destination: to,
                asset: asset,
                amount: amount,
            }))
            .setTimeout(30)
            .build();

        transaction.sign(this.keypair);

        return this.server.sendTransaction(transaction);
    }

    /**
     * Invokes a Soroban contract (placeholder for logic).
     * @param contractId The ID of the contract to invoke
     * @param functionName The name of the function to call
     * @param args The arguments to pass to the function
     * @returns Submission result
     */
    async invokeContract(
        contractId: string,
        functionName: string,
        args: any[] = []
    ) {
        // Note: Soroban contract invocation requires additional setup (TransactionBuilder for Soroban)
        // This is a simplified version or placeholder as requested in 'optionally'
        const sourceAccount = await this.server.getAccount(this.keypair.publicKey());

        // In a real implementation, you'd use Contract.call or similar from @stellar/stellar-sdk
        // For now, we provide the structure as a starting point
        console.log(`Invoking contract ${contractId} function ${functionName} with args`, args);

        // Placeholder logic for contract invocation
        throw new Error('Soroban contract invocation logic requires specific setup');
    }

    /**
     * Gets the public key of the service's keypair.
     */
    getPublicKey(): string {
        return this.keypair.publicKey();
    }
}
