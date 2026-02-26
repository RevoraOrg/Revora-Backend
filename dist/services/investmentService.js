"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvestmentService = exports.InvalidInvestmentAmountError = exports.OfferingClosedError = exports.OfferingNotFoundError = void 0;
/**
 * Custom error classes for investment service
 */
class OfferingNotFoundError extends Error {
    constructor(offeringId) {
        super(`Offering with ID ${offeringId} not found`);
        this.name = "OfferingNotFoundError";
    }
}
exports.OfferingNotFoundError = OfferingNotFoundError;
class OfferingClosedError extends Error {
    constructor(offeringId) {
        super(`Offering with ID ${offeringId} is not active`);
        this.name = "OfferingClosedError";
    }
}
exports.OfferingClosedError = OfferingClosedError;
class InvalidInvestmentAmountError extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidInvestmentAmountError";
    }
}
exports.InvalidInvestmentAmountError = InvalidInvestmentAmountError;
/**
 * Investment Service
 * Handles business logic for investments
 */
class InvestmentService {
    constructor(investmentRepository, offeringRepository) {
        this.investmentRepository = investmentRepository;
        this.offeringRepository = offeringRepository;
    }
    /**
     * Create a new investment
     * @param input Investment data
     * @returns Created investment
     * @throws OfferingNotFoundError if offering doesn't exist
     * @throws OfferingClosedError if offering is not active
     * @throws InvalidInvestmentAmountError if amount is invalid
     */
    async createInvestment(input) {
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
    validateInvestmentAmount(amount, offering) {
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0) {
            throw new InvalidInvestmentAmountError("Investment amount must be a positive number");
        }
        const minInvestment = parseFloat(offering.min_investment);
        if (amountNum < minInvestment) {
            throw new InvalidInvestmentAmountError(`Investment amount must be at least ${minInvestment}`);
        }
        if (offering.max_investment) {
            const maxInvestment = parseFloat(offering.max_investment);
            if (amountNum > maxInvestment) {
                throw new InvalidInvestmentAmountError(`Investment amount cannot exceed ${maxInvestment}`);
            }
        }
    }
    /**
     * Get an investment by ID
     * @param id Investment ID
     * @returns Investment if found, undefined otherwise
     */
    async getInvestment(id) {
        return this.investmentRepository.findById(id);
    }
    /**
     * Get investments by offering
     * @param offeringId Offering ID
     * @returns Array of investments
     */
    async getInvestmentsByOffering(offeringId) {
        return this.investmentRepository.findByOffering(offeringId);
    }
    /**
     * Get investments by investor
     * @param investorId Investor ID
     * @returns Array of investments
     */
    async getInvestmentsByInvestor(investorId) {
        return this.investmentRepository.findByInvestor(investorId);
    }
}
exports.InvestmentService = InvestmentService;
