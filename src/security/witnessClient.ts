/**
 * Interface for publishing audit log integrity roots to a public witness.
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
 * A mock witness client for testing and development.
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
