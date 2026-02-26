import {
  InvestmentRepository,
  Investment,
  CreateInvestmentInput,
} from "../db/repositories/investmentRepository";
import {
  OfferingRepository,
  Offering,
} from "../db/repositories/offeringRepository";

/**
 * Custom error classes for investment service
 */
export class OfferingNotFoundError extends Error {
  constructor(offeringId: string) {
    super(`Offering with ID ${offeringId} not found`);
    this.name = "OfferingNotFoundError";
  }
}

export class OfferingClosedError extends Error {
  constructor(offeringId: string) {
    super(`Offering with ID ${offeringId} is not active`);
    this.name = "OfferingClosedError";
  }
}

export class InvalidInvestmentAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvestmentAmountError";
  }
}

/**
 * Investment Service
 * Handles business logic for investments
 */
export class InvestmentService {
  constructor(
    private readonly investmentRepository: InvestmentRepository,
    private readonly offeringRepository: OfferingRepository,
  ) {}

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   * @throws OfferingNotFoundError if offering doesn't exist
   * @throws OfferingClosedError if offering is not active
   * @throws InvalidInvestmentAmountError if amount is invalid
   */
  async createInvestment(input: CreateInvestmentInput): Promise<Investment> {
    // Validate offering exists and is active
    const offering = await this.offeringRepository.findById(input.offering_id);

    if (!offering) {
      throw new OfferingNotFoundError(input.offering_id);
    }

    if (offering.status !== "active") {
      throw new OfferingClosedError(input.offering_id);
    }

    // Validate investment amount
    this.validateInvestmentAmount(input.amount, offering);

    // Create the investment
    const investment = await this.investmentRepository.create({
      offering_id: input.offering_id,
      investor_id: input.investor_id,
      amount: input.amount,
      status: input.status || "pending",
      transaction_hash: input.transaction_hash,
    });

    return investment;
  }

  /**
   * Validate investment amount against offering constraints
   * @param amount Investment amount as string
   * @param offering The offering to validate against
   * @throws InvalidInvestmentAmountError if amount is invalid
   */
  private validateInvestmentAmount(amount: string, offering: Offering): void {
    const amountNum = parseFloat(amount);

    if (isNaN(amountNum) || amountNum <= 0) {
      throw new InvalidInvestmentAmountError(
        "Investment amount must be a positive number",
      );
    }

    const minInvestment = parseFloat(offering.min_investment);
    if (amountNum < minInvestment) {
      throw new InvalidInvestmentAmountError(
        `Investment amount must be at least ${minInvestment}`,
      );
    }

    if (offering.max_investment) {
      const maxInvestment = parseFloat(offering.max_investment);
      if (amountNum > maxInvestment) {
        throw new InvalidInvestmentAmountError(
          `Investment amount cannot exceed ${maxInvestment}`,
        );
      }
    }
  }

  /**
   * Get an investment by ID
   * @param id Investment ID
   * @returns Investment if found, undefined otherwise
   */
  async getInvestment(id: string): Promise<Investment | undefined> {
    return this.investmentRepository.findById(id);
  }

  /**
   * Get investments by offering
   * @param offeringId Offering ID
   * @returns Array of investments
   */
  async getInvestmentsByOffering(offeringId: string): Promise<Investment[]> {
    return this.investmentRepository.findByOffering(offeringId);
  }

  /**
   * Get investments by investor
   * @param investorId Investor ID
   * @returns Array of investments
   */
  async getInvestmentsByInvestor(investorId: string): Promise<Investment[]> {
    return this.investmentRepository.findByInvestor(investorId);
  }
}
