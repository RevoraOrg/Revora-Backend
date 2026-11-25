/**
 * TaxationHandler: HTTP request handler for tax cost-basis operations.
 *
 * Security Assumptions:
 * - The investor_id has been authenticated via JWT middleware before handler invocation.
 * - The investor is authorized to access their own tax data.
 * - Request body has been validated against schema.
 *
 * All errors are mapped to AppError instances to ensure:
 * - Structured error responses with machine-readable error codes.
 * - No raw database or service errors leak to clients.
 * - Proper HTTP status codes and security classification.
 *
 * @module handlers/taxationHandler
 */

import { Response, NextFunction } from 'express';
import { TaxationService } from '../services/taxation/taxationService';
import { AuthenticatedRequest } from '../middleware/auth';
import { AppError, Errors } from '../lib/errors';
import { Logger } from '../lib/logger';
import { LogLevel } from '../lib/logger';
import { DisposalStrategy } from '../services/taxation/types';
import { isPositiveDecimalAmount } from '../lib/amountValidation';
import { Decimal } from '../lib/decimal';

const VALID_STRATEGIES: DisposalStrategy[] = ['FIFO', 'LIFO', 'HIFO'];

/**
 * Maximum accepted magnitude for quantities and per-unit monetary values.
 * Values above this bound are rejected to prevent precision loss and
 * overflow in gain/loss and lot calculations.
 */
export const MAX_NUMERIC_INPUT = 1e12;

/**
 * Returns true when value is a finite number strictly greater than zero
 * and no larger than MAX_NUMERIC_INPUT.
 */
export function isFinitePositive(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_NUMERIC_INPUT
  );
}

/**
 * Returns true when value is a finite number greater than or equal to zero
 * (negative zero is treated as zero) and no larger than MAX_NUMERIC_INPUT.
 */
export function isFiniteNonNegative(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= MAX_NUMERIC_INPUT
  );
}

/**
 * Validates a positive money or quantity amount: accepts a decimal string meeting
 * isPositiveDecimalAmount (up to 10 decimal places, no negative or exponential values)
 * or a positive finite number (deprecated backward-compatibility path).
 */
export function validatePositiveAmount(value: unknown, fieldName: string): number | string {
  if (typeof value === 'string') {
    if (!isPositiveDecimalAmount(value)) {
      throw Errors.validationError(
        `${fieldName} must be a positive decimal string with up to 10 decimal places`
      );
    }
    const dec = new Decimal(value);
    if (dec.compareTo(new Decimal(String(MAX_NUMERIC_INPUT))) > 0) {
      throw Errors.validationError(
        `${fieldName} exceeds maximum allowed value of ${MAX_NUMERIC_INPUT}`
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!isFinitePositive(value)) {
      throw Errors.validationError(
        `${fieldName} must be a positive finite number no greater than ${MAX_NUMERIC_INPUT}`
      );
    }
    return value;
  }
  throw Errors.validationError(`${fieldName} must be a decimal string or positive number`);
}

/**
 * Validates a non-negative money or unit price amount: accepts a decimal string
 * (positive decimal string or exact zero) or a non-negative finite number (deprecated path).
 */
export function validateNonNegativeAmount(value: unknown, fieldName: string): number | string {
  if (typeof value === 'string') {
    if (/^0+(\.0{1,10})?$/.test(value)) {
      return value;
    }
    if (!isPositiveDecimalAmount(value)) {
      throw Errors.validationError(
        `${fieldName} must be a non-negative decimal string with up to 10 decimal places`
      );
    }
    const dec = new Decimal(value);
    if (dec.compareTo(new Decimal(String(MAX_NUMERIC_INPUT))) > 0) {
      throw Errors.validationError(
        `${fieldName} exceeds maximum allowed value of ${MAX_NUMERIC_INPUT}`
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!isFiniteNonNegative(value)) {
      throw Errors.validationError(
        `${fieldName} must be a non-negative finite number no greater than ${MAX_NUMERIC_INPUT}`
      );
    }
    return value;
  }
  throw Errors.validationError(`${fieldName} must be a decimal string or non-negative number`);
}

function isValidStrategy(value: unknown): value is DisposalStrategy {
  return typeof value === 'string' && (VALID_STRATEGIES as string[]).includes(value);
}

export class TaxationHandler {
  private logger: Logger;

  constructor(private taxationService: TaxationService) {
    this.logger = new Logger({ level: LogLevel.INFO });
  }

  /**
   * Handle POST /taxation/dispose
   *
   * Processes a disposal of investment units using the specified cost-basis strategy.
   *
   * @returns 201 with DisposalResult on success
   */
  processDisposal: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void> = async (req, res, next) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      const { offering_id, quantity, disposal_price_per_unit, strategy } = req.body;

      // Validate required fields
      if (!offering_id) {
        return next(Errors.validationError('Missing required field: offering_id'));
      }
      if (quantity === undefined || quantity === null) {
        return next(Errors.validationError('Missing required field: quantity'));
      }
      if (disposal_price_per_unit === undefined || disposal_price_per_unit === null) {
        return next(Errors.validationError('Missing required field: disposal_price_per_unit'));
      }
      if (!strategy) {
        return next(Errors.validationError('Missing required field: strategy'));
      }

      // Validate types and bounds (accepts decimal strings or deprecated numbers)
      let validatedQuantity: number | string;
      let validatedDisposalPrice: number | string;
      try {
        validatedQuantity = validatePositiveAmount(quantity, 'quantity');
        validatedDisposalPrice = validateNonNegativeAmount(disposal_price_per_unit, 'disposal_price_per_unit');
      } catch (err) {
        return next(err);
      }

      if (!isValidStrategy(strategy)) {
        return next(
          Errors.validationError(
            `Invalid strategy: ${strategy}. Supported strategies: FIFO, LIFO, HIFO`
          )
        );
      }

      this.logger.info('Processing disposal', {
        requestId,
        userId,
        offering_id,
        quantity: validatedQuantity,
        strategy,
      });

      const result = await this.taxationService.processDisposal({
        investor_id: userId,
        offering_id,
        quantity: validatedQuantity,
        disposal_price_per_unit: validatedDisposalPrice,
        strategy,
        disposed_at: new Date(),
      });

      this.logger.info('Disposal processed successfully', {
        requestId,
        userId,
        realizedGainLoss: result.realizedGainLoss,
        strategy: result.strategy,
        allocationCount: result.allocations.length,
      });

      res.status(201).json({
        message: 'Disposal processed successfully',
        data: result,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error during disposal processing', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };

  /**
   * Handle POST /taxation/preview
   *
   * Previews a disposal without executing it, showing which lots would be consumed.
   *
   * @returns 200 with DisposalResult preview
   */
  previewDisposal: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void> = async (req, res, next) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      const { offering_id, quantity, disposal_price_per_unit, strategy } = req.body;

      if (!offering_id) {
        return next(Errors.validationError('Missing required field: offering_id'));
      }
      if (quantity === undefined || quantity === null) {
        return next(Errors.validationError('Missing required field: quantity'));
      }
      if (disposal_price_per_unit === undefined || disposal_price_per_unit === null) {
        return next(Errors.validationError('Missing required field: disposal_price_per_unit'));
      }
      if (!strategy) {
        return next(Errors.validationError('Missing required field: strategy'));
      }

      // Validate types and bounds (accepts decimal strings or deprecated numbers)
      let validatedQuantity: number | string;
      let validatedDisposalPrice: number | string;
      try {
        validatedQuantity = validatePositiveAmount(quantity, 'quantity');
        validatedDisposalPrice = validateNonNegativeAmount(disposal_price_per_unit, 'disposal_price_per_unit');
      } catch (err) {
        return next(err);
      }

      if (!isValidStrategy(strategy)) {
        return next(
          Errors.validationError(
            `Invalid strategy: ${strategy}. Supported strategies: FIFO, LIFO, HIFO`
          )
        );
      }

      this.logger.info('Previewing disposal', {
        requestId,
        userId,
        offering_id,
        quantity: validatedQuantity,
        strategy,
      });

      const result = await this.taxationService.previewDisposal({
        investor_id: userId,
        offering_id,
        quantity: validatedQuantity,
        disposal_price_per_unit: validatedDisposalPrice,
        strategy,
      });

      res.status(200).json({
        message: 'Disposal preview generated successfully',
        data: result,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error during disposal preview', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };

  /**
   * Handle GET /taxation/gains-summary
   *
   * Returns per-jurisdiction gains totals for the authenticated investor.
   *
   * @returns 200 with array of JurisdictionGainsSummary
   */
  getGainsSummary = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      this.logger.info('Fetching gains summary', { requestId, userId });

      const summary = await this.taxationService.getJurisdictionGainsSummary(userId);

      res.status(200).json({
        message: 'Gains summary retrieved successfully',
        data: summary,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error getting gains summary', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };

  /**
   * Handle GET /taxation/lots
   *
   * Lists all investment lots for the authenticated investor.
   *
   * @returns 200 with array of InvestmentLot
   */
  listLots = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      this.logger.info('Listing investment lots', { requestId, userId });

      const lots = await this.taxationService.listLots(userId);

      res.status(200).json({
        message: 'Lots retrieved successfully',
        data: lots,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error listing lots', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };

  /**
   * Handle POST /taxation/wash-sale-detection
   *
   * Detects wash-sale conditions for a disposal and creates cost-basis adjustments
   * if applicable. The adjustment is idempotent per (investor, offering, disposed_at).
   *
   * @returns 200 with WashSaleDetectionResult
   */
  detectWashSales = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      const {
        offering_id,
        disposed_at,
        disposal_realized_gain_loss,
        disposal_quantity,
        disposal_cost_basis_per_unit,
        window_days,
      } = req.body;

      if (!offering_id) {
        return next(Errors.validationError('Missing required field: offering_id'));
      }
      if (!disposed_at) {
        return next(Errors.validationError('Missing required field: disposed_at'));
      }
      if (disposal_realized_gain_loss === undefined || disposal_realized_gain_loss === null) {
        return next(Errors.validationError('Missing required field: disposal_realized_gain_loss'));
      }
      if (disposal_quantity === undefined || disposal_quantity === null) {
        return next(Errors.validationError('Missing required field: disposal_quantity'));
      }
      if (disposal_cost_basis_per_unit === undefined || disposal_cost_basis_per_unit === null) {
        return next(Errors.validationError('Missing required field: disposal_cost_basis_per_unit'));
      }

      if (typeof disposal_realized_gain_loss !== 'number') {
        return next(Errors.validationError('disposal_realized_gain_loss must be a number'));
      }
      if (typeof disposal_quantity !== 'number' || disposal_quantity <= 0) {
        return next(Errors.validationError('disposal_quantity must be a positive number'));
      }
      if (typeof disposal_cost_basis_per_unit !== 'number' || disposal_cost_basis_per_unit < 0) {
        return next(Errors.validationError('disposal_cost_basis_per_unit must be non-negative'));
      }
      if (window_days !== undefined && (typeof window_days !== 'number' || window_days < 1 || window_days > 365)) {
        return next(Errors.validationError('window_days must be between 1 and 365'));
      }

      this.logger.info('Running wash-sale detection', {
        requestId,
        userId,
        offering_id,
        disposal_realized_gain_loss,
        window_days,
      });

      const result = await this.taxationService.detectWashSales({
        investor_id: userId,
        offering_id,
        disposed_at: new Date(disposed_at),
        disposal_realized_gain_loss,
        disposal_quantity,
        disposal_cost_basis_per_unit,
        window_days,
      });

      this.logger.info('Wash-sale detection complete', {
        requestId,
        userId,
        isWashSale: result.isWashSale,
        adjustmentCount: result.adjustments.length,
        adjustmentAmount: result.adjustmentAmount,
      });

      res.status(200).json({
        message: result.isWashSale
          ? 'Wash-sale condition detected and adjustments recorded'
          : 'No wash-sale condition detected',
        data: result,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error during wash-sale detection', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };

  /**
   * Handle POST /taxation/lots
   *
   * Creates a new investment lot. `acquired_at` is optional and defaults to now.
   * When provided it must be a parseable date that is not in the future.
   *
   * @returns 201 with the created InvestmentLot
   */
  createLot = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      const { offering_id, investment_id, asset, quantity, cost_basis_per_unit, acquired_at: rawAcquiredAt, cost_currency, jurisdiction } = req.body;

      if (!offering_id) {
        return next(Errors.validationError('Missing required field: offering_id'));
      }
      if (!investment_id) {
        return next(Errors.validationError('Missing required field: investment_id'));
      }
      if (!asset) {
        return next(Errors.validationError('Missing required field: asset'));
      }
      if (quantity === undefined || quantity === null) {
        return next(Errors.validationError('Missing required field: quantity'));
      }
      if (cost_basis_per_unit === undefined || cost_basis_per_unit === null) {
        return next(Errors.validationError('Missing required field: cost_basis_per_unit'));
      }

      let validatedQuantity: number | string;
      let validatedCostBasis: number | string;
      try {
        validatedQuantity = validatePositiveAmount(quantity, 'quantity');
        validatedCostBasis = validateNonNegativeAmount(cost_basis_per_unit, 'cost_basis_per_unit');
      } catch (err) {
        return next(err);
      }

      let acquiredAt: Date;
      if (rawAcquiredAt === undefined || rawAcquiredAt === null) {
        acquiredAt = new Date();
      } else {
        if (typeof rawAcquiredAt !== 'string' && typeof rawAcquiredAt !== 'number') {
          return next(Errors.validationError('acquired_at must be a valid date'));
        }
        acquiredAt = new Date(rawAcquiredAt);
        if (Number.isNaN(acquiredAt.getTime())) {
          return next(Errors.validationError('acquired_at must be a valid date'));
        }
        if (acquiredAt.getTime() > Date.now()) {
          return next(Errors.validationError('acquired_at cannot be in the future'));
        }
      }

      this.logger.info('Creating investment lot', {
        requestId,
        userId,
        acquired_at: acquiredAt.toISOString(),
      });

      const lot = await this.taxationService.createLot({
        investor_id: userId,
        offering_id,
        investment_id,
        asset,
        quantity: validatedQuantity,
        cost_basis_per_unit: validatedCostBasis,
        cost_currency,
        jurisdiction,
        acquired_at: acquiredAt,
      });

      res.status(201).json({
        message: 'Lot created successfully',
        data: lot,
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
      } else {
        this.logger.error('Unexpected error creating lot', { error });
        next(Errors.internal('Internal server error'));
      }
    }
  };
}
