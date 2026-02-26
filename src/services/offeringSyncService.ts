import { OfferingRepository, Offering, UpdateOfferingStateInput } from '../db/repositories/offeringRepository';

/**
 * On-chain offering state returned by Soroban/Stellar contract
 */
export interface OnChainOfferingState {
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string;
}

/**
 * Soroban/Stellar client interface
 * Implement this with the actual Stellar SDK when available.
 * Stubbed here so the service is testable without a live network.
 */
export interface StellarClient {
  getOfferingState(contractAddress: string): Promise<OnChainOfferingState>;
}

/**
 * Result of a single offering sync
 */
export interface SyncResult {
  offeringId: string;
  contractAddress: string;
  success: boolean;
  updated: boolean;
  error?: string;
}

/**
 * Offering Sync Service
 * Reads offering state from the Soroban contract and updates the local DB.
 * Can be triggered by an API endpoint or a cron job.
 */
export class OfferingSyncService {
  constructor(
    private offeringRepository: OfferingRepository,
    private stellarClient: StellarClient
  ) {}

  /**
   * Sync a single offering by ID
   * @param offeringId The local offering ID
   * @returns SyncResult
   */
  async syncOffering(offeringId: string): Promise<SyncResult> {
    const offering = await this.offeringRepository.findById(offeringId);
    if (!offering) {
      return {
        offeringId,
        contractAddress: '',
        success: false,
        updated: false,
        error: `Offering ${offeringId} not found`,
      };
    }

    return this.syncFromChain(offering);
  }

  /**
   * Sync all offerings in the DB against the chain
   * @returns Array of SyncResults
   */
  async syncAll(): Promise<SyncResult[]> {
    const offerings = await this.offeringRepository.listAll();
    const results = await Promise.allSettled(
      offerings.map((o) => this.syncFromChain(o))
    );

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return {
        offeringId: offerings[i].id,
        contractAddress: offerings[i].contract_address,
        success: false,
        updated: false,
        error: r.reason?.message ?? 'Unknown error',
      };
    });
  }

  /**
   * Core sync logic: read from chain, compare, update DB if changed
   */
  private async syncFromChain(offering: Offering): Promise<SyncResult> {
    try {
      const onChain = await this.stellarClient.getOfferingState(
        offering.contract_address
      );

      const hasChanged =
        onChain.status !== offering.status ||
        onChain.total_raised !== offering.total_raised;

      if (!hasChanged) {
        return {
          offeringId: offering.id,
          contractAddress: offering.contract_address,
          success: true,
          updated: false,
        };
      }

      const update: UpdateOfferingStateInput = {
        status: onChain.status,
        total_raised: onChain.total_raised,
      };

      await this.offeringRepository.updateState(offering.id, update);

      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address,
        success: true,
        updated: true,
      };
    } catch (err: any) {
      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address,
        success: false,
        updated: false,
        error: err.message ?? 'Unknown error',
      };
    }
  }
}