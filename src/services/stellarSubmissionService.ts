// @ts-ignore
import * as StellarSdk from 'stellar-sdk';

/**
 * Helper service to build and submit Stellar transactions.
 * Uses the server keypair loaded from the environment config.
 */
export class StellarSubmissionService {
    private server: any;
    private serverKeypair: any;
    private networkPassphrase: string;

    constructor() {
        const secret = process.env.STELLAR_SERVER_SECRET;
        if (!secret) {
            throw new Error('STELLAR_SERVER_SECRET is not configured.');
        }

        this.serverKeypair = StellarSdk.Keypair.fromSecret(secret);

        const horizonUrl =
            process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
        this.server = new StellarSdk.Server(horizonUrl);

        this.networkPassphrase =
            process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
    }

    /**
     * Submits a payment transaction from a specified account to a destination.
     * Signed and built by the server keypair.
     *
     * @param from  Source Stellar public address (used as the operation source)
     * @param to    Destination Stellar public address
     * @param amount Amount to send as a string (e.g. "10.5")
     * @param asset Stellar Asset to send (defaults to native XLM)
     * @returns The Horizon transaction response
     */
    async submitPayment(
        from: string,
        to: string,
        amount: string,
        asset: any = StellarSdk.Asset.native()
    ) {
        const sourceAccount = await this.server.loadAccount(
            this.serverKeypair.publicKey()
        );

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(
                StellarSdk.Operation.payment({
                    source: from,
                    destination: to,
                    asset,
                    amount,
                })
            )
            .setTimeout(30)
            .build();

        tx.sign(this.serverKeypair);

        return this.server.submitTransaction(tx);
    }

    /**
     * Submits a generic single-operation transaction signed by the server keypair.
     *
     * @param operation Any Stellar Operation object
     * @returns The Horizon transaction response
     */
    async submitOperation(operation: any) {
        const sourceAccount = await this.server.loadAccount(
            this.serverKeypair.publicKey()
        );

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(operation)
            .setTimeout(30)
            .build();

        tx.sign(this.serverKeypair);

        return this.server.submitTransaction(tx);
    }

    /**
     * Invokes a Soroban smart contract on-chain.
     *
     * @param contractId Stellar contract address (C... format)
     * @param method     Contract function name to invoke
     * @param args       XDR ScVal arguments for the function
     * @returns The Horizon transaction response
     */
    async invokeContract(
        contractId: string,
        method: string,
        args: any[] = []
    ) {
        const sourceAccount = await this.server.loadAccount(
            this.serverKeypair.publicKey()
        );

        const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(
                StellarSdk.Operation.invokeHostFunction({
                    func: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
                        new StellarSdk.xdr.InvokeContractArgs({
                            contractAddress: StellarSdk.Address.fromString(
                                contractId
                            ).toScAddress(),
                            functionName: method,
                            args,
                        })
                    ),
                    auth: [],
                })
            )
            .setTimeout(30)
            .build();

        tx.sign(this.serverKeypair);

        return this.server.submitTransaction(tx);
    }
}

/**
 * Lazily-created singleton.  We purposely do NOT instantiate this at module
 * load time so that tests can import the class before environment variables
 * are available.
 *
 * Usage:
 *   import { getStellarService } from './stellarSubmissionService';
 *   const result = await getStellarService().submitPayment(from, to, amount);
 */
let _instance: StellarSubmissionService | null = null;

export function getStellarService(): StellarSubmissionService {
    if (!_instance) {
        _instance = new StellarSubmissionService();
    }
    return _instance;
}
