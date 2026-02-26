import { BalanceSnapshotRepository, CreateSnapshotInput, TokenBalanceSnapshot } from '../db/repositories/balanceSnapshotRepository';
import { OfferingRepository, Offering } from '../db/repositories/offeringRepository';
import type { StellarClient as OfferingStellarClient } from './offeringSyncService';

/**
 * Represents a single holder balance for an offering.
 * `holderAddressOrId` can be a Stellar address or an internal user/investor ID.
 */
export interface HolderBalance {
  holderAddressOrId: string;
  balance: string;
}

/**
 * Source of balances for a given offering and period when using the database
 * (e.g. aggregating from investments or a dedicated holdings table).
 */
export interface BalanceProvider {
  getBalances(offeringId: string, periodId: string): Promise<HolderBalance[]>;
}

export type BalanceSourceType = 'stellar' | 'db' | 'auto';

/**
 * Soroban/Stellar client capable of returning per-holder token balances
 * for a given offering contract and period.
 *
 * It extends the basic `StellarClient` used by `OfferingSyncService` so that
 * a single implementation can be reused.
 */
export interface StellarBalanceClient extends OfferingStellarClient {
  getHolderBalances(
    contractAddress: string,
    periodId: string
  ): Promise<HolderBalance[]>;
}

export interface SnapshotBalancesInput {
  offeringId: string;
  /**
   * Business period identifier (e.g. `2024-01` or a UUID).
   * This is written directly to `token_balance_snapshots.period_id`.
   */
  periodId: string;
  /**
   * Optional timestamp for the snapshot. Defaults to `new Date()`.
   * All rows in a single run share the same `snapshot_at` value.
   */
  snapshotAt?: Date;
  /**
   * Explicit source of balances:
   * - `stellar`: always read from Soroban/Stellar client
   * - `db`: always read from the provided DB balance provider
   * - `auto` (default): prefer DB provider if present, otherwise Stellar client
   */
  source?: BalanceSourceType;
  /**
   * If true (default), the service will first check for existing snapshots
   * for `(offeringId, periodId)` and return them without inserting new rows.
   * Set to `false` to always compute and insert a fresh snapshot.
   */
  skipIfExists?: boolean;
}

export interface SnapshotBalancesResult {
  offeringId: string;
  periodId: string;
  snapshots: TokenBalanceSnapshot[];
  fromSource: Exclude<BalanceSourceType, 'auto'>;
}

/**
 * BalanceSnapshotService
 *
 * Orchestrates fetching token balances for a given offering and business period
 * (from Stellar/Soroban or from an existing DB source) and persisting them into
 * the `token_balance_snapshots` table via `BalanceSnapshotRepository`.
 *
 * This service is intentionally stateless and side-effect free beyond
 * repository calls so it can be triggered from either an HTTP API handler
 * or an internal scheduler/cron job.
 */
export class BalanceSnapshotService {
  constructor(
    private readonly balanceSnapshotRepository: BalanceSnapshotRepository,
    private readonly offeringRepository: OfferingRepository,
    /**
     * Optional on-chain client for fetching per-holder balances from Soroban/Stellar.
     */
    private readonly stellarClient?: StellarBalanceClient,
    /**
     * Optional DB-based balance provider (e.g. aggregating from investments).
     */
    private readonly dbBalanceProvider?: BalanceProvider
  ) {}

  /**
   * Compute and persist token balance snapshots for a given offering and period.
   *
   * - Validates that the offering exists
   * - Optionally short-circuits if snapshots already exist (idempotent mode)
   * - Fetches balances from either DB or Stellar/Soroban
   * - Writes rows into `token_balance_snapshots` via `insertMany`
   *
   * Intended usage:
   * - Called from an API endpoint when an issuer triggers a snapshot
   * - Called from a cron/scheduler after a revenue period closes
   */
  async snapshotBalances(
    input: SnapshotBalancesInput
  ): Promise<SnapshotBalancesResult> {
    const {
      offeringId,
      periodId,
      snapshotAt,
      source = 'auto',
      skipIfExists = true,
    } = input;

    if (!offeringId) {
      throw new Error('offeringId is required');
    }

    if (!periodId) {
      throw new Error('periodId is required');
    }

    const offering = await this.offeringRepository.findById(offeringId);
    if (!offering) {
      throw new Error(`Offering ${offeringId} not found`);
    }

    if (skipIfExists) {
      const existing = await this.balanceSnapshotRepository.findByOfferingAndPeriod(
        offeringId,
        periodId
      );
      if (existing.length > 0) {
        return {
          offeringId,
          periodId,
          snapshots: existing,
          fromSource: this.resolveEffectiveSource(source),
        };
      }
    }

    const effectiveSource = this.resolveSourceForRun(source);
    const balances =
      effectiveSource === 'db'
        ? await this.getBalancesFromDb(offering.id, periodId)
        : await this.getBalancesFromStellar(offering, periodId);

    if (!balances || balances.length === 0) {
      throw new Error(
        `No balances found for offering ${offering.id} and period ${periodId}`
      );
    }

    const normalizedSnapshotAt = snapshotAt ?? new Date();

    const inputs: CreateSnapshotInput[] = balances.map((b) => ({
      offering_id: offering.id,
      period_id: periodId,
      holder_address_or_id: b.holderAddressOrId,
      balance: b.balance,
      snapshot_at: normalizedSnapshotAt,
    }));

    const snapshots = await this.balanceSnapshotRepository.insertMany(inputs);

    return {
      offeringId: offering.id,
      periodId,
      snapshots,
      fromSource: effectiveSource,
    };
  }

  private resolveEffectiveSource(source: BalanceSourceType): Exclude<BalanceSourceType, 'auto'> {
    if (source === 'auto') {
      return this.dbBalanceProvider ? 'db' : 'stellar';
    }
    return source === 'db' ? 'db' : 'stellar';
  }

  private resolveSourceForRun(source: BalanceSourceType): Exclude<BalanceSourceType, 'auto'> {
    const effective = this.resolveEffectiveSource(source);

    if (effective === 'db' && !this.dbBalanceProvider) {
      throw new Error('DB balance provider is not configured');
    }

    if (effective === 'stellar' && !this.stellarClient) {
      throw new Error('Stellar/Soroban client is not configured');
    }

    return effective;
  }

  private async getBalancesFromDb(
    offeringId: string,
    periodId: string
  ): Promise<HolderBalance[]> {
    if (!this.dbBalanceProvider) {
      throw new Error('DB balance provider is not configured');
    }

    const balances = await this.dbBalanceProvider.getBalances(
      offeringId,
      periodId
    );

    return this.normalizeBalances(balances);
  }

  private async getBalancesFromStellar(
    offering: Offering,
    periodId: string
  ): Promise<HolderBalance[]> {
    if (!this.stellarClient) {
      throw new Error('Stellar/Soroban client is not configured');
    }

    if (!offering.contract_address) {
      throw new Error(
        `Offering ${offering.id} does not have a contract_address configured`
      );
    }

    const balances = await this.stellarClient.getHolderBalances(
      offering.contract_address,
      periodId
    );

    return this.normalizeBalances(balances);
  }

  private normalizeBalances(balances: HolderBalance[]): HolderBalance[] {
    return balances
      .map((b) => ({
        holderAddressOrId: b.holderAddressOrId,
        balance: b.balance,
      }))
      .filter((b) => {
        if (!b.holderAddressOrId) return false;
        const numeric = Number(b.balance);
        return !Number.isNaN(numeric) && numeric > 0;
      });
  }
}

/**
 * Helper to create a simple DB balance provider that aggregates completed
 * investments per investor for an offering. This uses the `InvestmentRepository`
 * and can be used when token balances are 1:1 with invested amounts.
 *
 * NOTE: The periodId parameter is currently ignored by this implementation;
 * callers are responsible for deciding which investments belong to a period.
 */
export function createDbBalanceProviderFromInvestments(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  investmentRepository: { findByOffering(offeringId: string): Promise<any[]> }
): BalanceProvider {
  return {
    async getBalances(offeringId: string): Promise<HolderBalance[]> {
      const investments = await investmentRepository.findByOffering(offeringId);

      const byInvestor = new Map<string, number>();

      for (const inv of investments) {
        if (inv.status !== 'completed') continue;
        const key = String(inv.investor_id);
        const current = byInvestor.get(key) ?? 0;
        const amountNum = Number(inv.amount);
        if (Number.isNaN(amountNum) || amountNum <= 0) continue;
        byInvestor.set(key, current + amountNum);
      }

      return Array.from(byInvestor.entries()).map(
        ([holderAddressOrId, balanceNum]) => ({
          holderAddressOrId,
          balance: balanceNum.toString(),
        })
      );
    },
  };
}

