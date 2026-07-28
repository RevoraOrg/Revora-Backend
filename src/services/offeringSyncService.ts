import {
  OfferingRepository,
  Offering,
  UpdateOfferingStateInput,
} from '../db/repositories/offeringRepository';
import {
  canTransition,
  normalizeOfferingStatus,
} from '../lib/offeringStatusGuard';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
  StellarRPCFailureContext
} from '../lib/stellarRpcFailure';
import { Logger, globalLogger } from '../lib/logger';
import { HorizonClient } from '../lib/stellar';
import { Errors } from '../lib/errors';

export interface OnChainOfferingState {
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string;
  /** Basis points (0–10000). Absent/null means no cap. */
  max_investor_share_bps?: number | null;
  last_updated_ledger?: number;
}

export interface StellarClient {
  getOfferingState(contractAddress: string): Promise<OnChainOfferingState>;
  getAccountInfo(publicKey: string): Promise<StellarAccount>;
  validateContractAddress(address: string): boolean;
}

/**
 * Real Stellar client implementation using Horizon and Soroban RPC
 */
export class RealStellarClient implements StellarClient {
  private horizonClient: HorizonClient;
  private rpcServerUrl: string;
  private logger: Logger;

  constructor(config: { horizonUrl?: string; rpcServerUrl?: string; logger?: Logger } = {}) {
    this.horizonClient = new HorizonClient({ serverUrl: config.horizonUrl });
    this.rpcServerUrl = config.rpcServerUrl || 'https://soroban-rpc.stellar.org';
    this.logger = config.logger || globalLogger.child({ component: 'StellarClient' });
  }

  async getOfferingState(contractAddress: string): Promise<OnChainOfferingState> {
    this.logger.info('Fetching offering state from chain', { contractAddress });
    
    try {
      // Validate contract address format
      if (!this.validateContractAddress(contractAddress)) {
        throw Errors.badRequest('Invalid contract address format');
      }

      // For now, simulate Soroban contract call
      // In production, this would use the actual Soroban RPC client
      const response = await this.fetchSorobanContract(contractAddress, 'get_offering_state');
      
      const state: OnChainOfferingState = {
        status: this.mapContractStatusToOfferingStatus(response.status),
        total_raised: response.total_raised || '0',
        last_updated_ledger: response.last_updated_ledger,
      };

      this.logger.debug('Successfully fetched offering state', {
        contractAddress,
        status: state.status,
        total_raised: state.total_raised,
      });

      return state;
    } catch (error) {
      const failure = classifyStellarRPCFailure(error, {
        operation: 'getOfferingState',
        offeringId: contractAddress, // using contractAddress as context
      });
      this.logger.error('Failed to fetch offering state', {
        contractAddress,
        error: error instanceof Error ? error.message : String(error),
        failureClass: failure.class,
      });
      throw error;
    }
  }

  async getAccountInfo(publicKey: string): Promise<StellarAccount> {
    this.logger.debug('Fetching account info from Horizon', { publicKey });
    return this.horizonClient.getAccount(publicKey);
  }

  validateContractAddress(address: string): boolean {
    // Stellar contract addresses are 32 bytes hex encoded
    const contractAddressRegex = /^[a-fA-F0-9]{64}$/;
    return contractAddressRegex.test(address);
  }

  private async fetchSorobanContract(contractAddress: string, method: string): Promise<any> {
    // Mock implementation - in production this would use actual Soroban RPC
    // This is a placeholder that demonstrates the integration pattern
    const mockResponse = {
      status: 'active',
      total_raised: '1000.0000000',
      last_updated_ledger: 12345,
    };

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 100));

    return mockResponse;
  }

  private mapContractStatusToOfferingStatus(contractStatus: string): 'draft' | 'active' | 'closed' | 'completed' {
    const statusMap: Record<string, 'draft' | 'active' | 'closed' | 'completed'> = {
      'draft': 'draft',
      'open': 'active',
      'active': 'active',
      'closed': 'closed',
      'completed': 'completed',
      'cancelled': 'closed',
    };
    return statusMap[contractStatus] || 'draft';
  }
}

export interface SyncResult {
  offeringId: string;
  contractAddress: string;
  success: boolean;
  updated: boolean;
  offering?: Offering;
  error?: string;
  failureClass?: StellarRPCFailureClass;
}

export class OfferingSyncService {
  private readonly logger: Logger;

  constructor(
    private readonly offeringRepository: OfferingRepository,
    private readonly stellarClient: StellarClient,
    logger: Logger = globalLogger,
  ) {
    this.logger = logger.child({ module: 'OfferingSyncService' });
  }

  async syncOffering(offeringId: string): Promise<SyncResult> {
    const startTime = Date.now();
    this.logger.info('Starting offering sync', { offeringId });

    try {
      const offering = await this.offeringRepository.findById(offeringId);
      if (!offering) {
        const result: SyncResult = {
          offeringId,
          contractAddress: '',
          success: false,
          updated: false,
          error: `Offering ${offeringId} not found`,
          duration: Date.now() - startTime,
        };
        this.logger.warn('Offering not found for sync', { offeringId });
        return result;
      }

      return this.syncFromChain(offering, startTime);
    } catch (error) {
      const result: SyncResult = {
        offeringId,
        contractAddress: '',
        success: false,
        updated: false,
        error: 'Offering not found',
      };
      this.logger.error('Failed to sync offering', {
        offeringId,
        error: result.error,
        failureClass: result.failureClass,
      });
      return result;
    }

    return this.syncOfferingRecord(offering);
  }

  async syncOfferingRecord(offering: Offering): Promise<SyncResult> {
    try {
      if (!offering.contract_address) {
        this.logger.warn('Skipping offering sync without contract address', {
          offeringId: offering.id,
        });

        return {
          offeringId: offering.id,
          contractAddress: '',
          success: false,
          updated: false,
          offering,
          error: 'Offering is not configured for on-chain sync',
        };
        this.logger.warn('Offering missing contract address', { offeringId: offering.id });
        return result;
      }

      const contractAddress = offering.contract_address;
      const onChain = await this.stellarClient.getOfferingState(contractAddress);

      const normalizedLocalStatus = normalizeOfferingStatus(offering.status);
      const normalizedChainStatus = normalizeOnChainStatus(onChain.status);

      if (!normalizedChainStatus) {
        this.logger.error('Received unsupported on-chain offering status', {
          offeringId: offering.id,
          contractAddress,
          chainStatus: onChain.status,
        });

        return {
          offeringId: offering.id,
          contractAddress,
          success: false,
          updated: false,
          offering,
          error: 'On-chain offering state is invalid',
        };
      }

      if (
        normalizedLocalStatus &&
        !canTransition(normalizedLocalStatus, normalizedChainStatus)
      ) {
        this.logger.warn('Rejected incompatible on-chain offering transition', {
          offeringId: offering.id,
          contractAddress,
          currentStatus: normalizedLocalStatus,
          chainStatus: normalizedChainStatus,
        });

        return {
          offeringId: offering.id,
          contractAddress,
          success: false,
          updated: false,
          offering,
          error: 'On-chain status is not compatible with catalog state',
        };
      }

      const hasChanged =
        normalizedChainStatus !== normalizedLocalStatus ||
        onChain.total_raised !== offering.total_raised ||
        onChain.max_investor_share_bps !== (offering.max_investor_share_bps as number | null | undefined);

      if (!hasChanged) {
        const result: SyncResult = {
          offeringId: offering.id,
          contractAddress,
          success: true,
          updated: false,
          offering: {
            ...offering,
            status: normalizedChainStatus,
            total_raised: onChain.total_raised,
          },
        };
        this.logger.debug('Offering state unchanged', {
          offeringId: offering.id,
          contractAddress,
        });
        return result;
      }

      const update: UpdateOfferingStateInput = {
        status: normalizedChainStatus,
        total_raised: onChain.total_raised,
        max_investor_share_bps: onChain.max_investor_share_bps ?? null,
      };

      const updatedOffering =
        (await this.offeringRepository.updateState(offering.id, update)) ?? {
          ...offering,
          ...update,
        };

      this.logger.info('Offering catalog synchronized with on-chain state', {
        offeringId: offering.id,
        contractAddress,
        previousStatus: normalizedLocalStatus ?? null,
        nextStatus: normalizedChainStatus,
        totalRaised: onChain.total_raised,
      });

      const result: SyncResult = {
        offeringId: offering.id,
        contractAddress,
        success: true,
        updated: true,
        offering: updatedOffering,
      };
      return result;
    } catch (error) {
      const failureClass = classifyStellarRPCFailure(error);

      this.logger.error('Offering sync failed against Stellar dependency', {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        failureClass,
        error,
      });

      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        success: false,
        updated: false,
        offering,
        error: 'Unable to sync offering from Stellar',
        failureClass,
      };
      
      this.logger.error('Failed to sync offering from chain', {
        offeringId: offering.id,
        contractAddress: offering.contract_address,
        error: result.error,
        failureClass: result.failureClass,
        duration: result.duration,
      });
      
      return result;
    }
  }

  async syncAll(): Promise<SyncResult[]> {
    const offerings = await this.offeringRepository.listAll();
    const results = await Promise.allSettled(
      offerings.map((offering) => this.syncOfferingRecord(offering)),
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const offering = offerings[index];
      const failureClass = classifyStellarRPCFailure(result.reason);

      this.logger.error('Offering sync task failed unexpectedly', {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        failureClass,
        error: result.reason,
      });

      return {
        offeringId: offering.id,
        contractAddress: offering.contract_address ?? '',
        success: false,
        updated: false,
        offering,
        error: 'Unable to sync offering from Stellar',
        failureClass,
      };
    });
  }
}

export function getSynchronizedOffering(
  result: SyncResult,
  fallback: Offering,
): Offering {
  return result.offering ?? fallback;
}

function normalizeOnChainStatus(
  status: OnChainOfferingState['status'],
): UpdateOfferingStateInput['status'] | null {
  const normalized = normalizeOfferingStatus(status);

  if (
    normalized === 'draft' ||
    normalized === 'active' ||
    normalized === 'closed' ||
    normalized === 'completed'
  ) {
    return normalized;
  }

  return null;
}
