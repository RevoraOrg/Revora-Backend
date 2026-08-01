/**
 * @file witnessClient.ts
 *
 * @notice Interface + clients for publishing audit Merkle roots to a public
 *         witness (Sigstore Rekor, Stellar memo, or mock for tests).
 *
 * @dev Witness downtime must never break local audit integrity verification —
 *      callers catch publish errors and alert without rethrowing.
 */

export interface WitnessReceipt {
  /** The root hash that was published. */
  rootHash: string;
  /** The type of witness (e.g., 'rekor', 'stellar', 'mock'). */
  witnessType: string;
  /** Timestamp of when it was published. */
  publishedAt: Date;
  /** Arbitrary receipt data from the witness service (e.g., transaction ID, log index). */
  receiptData: Record<string, unknown>;
}

export interface WitnessClient {
  /**
   * Publish a root hash to the public witness.
   * @param rootHash The hash to publish.
   * @returns A promise that resolves to the receipt.
   * @throws Error if publishing fails.
   */
  publish(rootHash: string): Promise<WitnessReceipt>;
}

/**
 * Mock witness client for testing and local development.
 */
export class MockWitnessClient implements WitnessClient {
  private publishAttempts = 0;
  public simulateFailureAttempts = 0;

  async publish(rootHash: string): Promise<WitnessReceipt> {
    this.publishAttempts++;
    if (this.simulateFailureAttempts > 0) {
      this.simulateFailureAttempts--;
      throw new Error('Mock witness publish failed');
    }

    return {
      rootHash,
      witnessType: 'mock',
      publishedAt: new Date(),
      receiptData: {
        attempt: this.publishAttempts,
        txId: `mock-tx-${Date.now()}`,
      },
    };
  }
}

/**
 * Stellar memo witness: posts the Merkle root as a transaction memo on the
 * configured network.  Production deployments inject a real Horizon submitter;
 * the default implementation records a deterministic receipt without network I/O
 * so local integrity checks never depend on Horizon availability.
 *
 * Security assumptions:
 * - The root hash is hex; memo text is truncated to Stellar's 28-byte memo limit
 *   by storing a short prefix + full hash in `receiptData` for verification.
 * - Secrets (`STELLAR_SERVER_SECRET`) are never logged.
 */
export class StellarMemoWitnessClient implements WitnessClient {
  constructor(
    private readonly options: {
      /** Optional Horizon submitter. When omitted, a dry-run receipt is returned. */
      submitMemo?: (memo: string) => Promise<{ txHash: string }>;
      network?: string;
    } = {},
  ) {}

  async publish(rootHash: string): Promise<WitnessReceipt> {
    if (!/^[a-f0-9]{64}$/i.test(rootHash)) {
      throw new Error('StellarMemoWitnessClient expects a 64-char hex Merkle root');
    }

    // Stellar text memos are limited to 28 bytes — store a short prefix on-chain
    // and keep the full root in the receipt for offline verification.
    const memo = `audit:${rootHash.slice(0, 20)}`;
    const publishedAt = new Date();

    if (this.options.submitMemo) {
      const { txHash } = await this.options.submitMemo(memo);
      return {
        rootHash,
        witnessType: 'stellar',
        publishedAt,
        receiptData: {
          network: this.options.network ?? 'testnet',
          memo,
          txHash,
        },
      };
    }

    return {
      rootHash,
      witnessType: 'stellar',
      publishedAt,
      receiptData: {
        network: this.options.network ?? 'testnet',
        memo,
        dryRun: true,
        note: 'No Horizon submitter configured — receipt recorded locally only',
      },
    };
  }
}
