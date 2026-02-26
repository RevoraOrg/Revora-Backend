import { Pool } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { Errors } from '../lib/errors';

/**
 * Input for creating an investment
 */
export interface CreateInvestmentRequest {
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
}

/**
 * Investment Service
 * Handles business logic for investments
 */
export class InvestmentService {
  constructor(
    private investmentRepo: InvestmentRepository,
    private offeringRepo: OfferingRepository
  ) {}

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   * @throws Error if offering not found or invalid
   */
  async createInvestment(input: CreateInvestmentRequest): Promise<Investment> {
    // 1. Validate offering exists
    const offering = await this.offeringRepo.findById(input.offering_id);
    if (!offering) {
      throw Errors.notFound(`Offering ${input.offering_id} not found`);
    }

    // 2. Validate offering is active
    const activeStatuses = ['active', 'open'];
    if (!offering.status || !activeStatuses.includes(offering.status)) {
      throw Errors.validationError(`Offering is not active. Current status: ${offering.status}`);
    }

    // 3. Validate amount
    const amountNum = parseFloat(input.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw Errors.validationError('Invalid amount: must be a positive number');
    }

    // 4. Validate asset
    if (!input.asset || input.asset.trim() === '') {
      throw Errors.validationError('Asset is required');
    }

    // 5. Create investment record
    const investmentInput: CreateInvestmentInput = {
      investor_id: input.investor_id,
      offering_id: input.offering_id,
      amount: input.amount,
      asset: input.asset,
      status: 'pending', // Default status until Stellar transaction is submitted
    };

    const investment = await this.investmentRepo.create(investmentInput);

    return investment;
  }
}

/**
 * Factory function to create InvestmentService with dependencies
 */
export function createInvestmentService(db: Pool): InvestmentService {
  return new InvestmentService(
    new InvestmentRepository(db),
    new OfferingRepository(db)
  );
}
