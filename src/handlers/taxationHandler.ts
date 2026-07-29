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

const VALID_STRATEGIES: DisposalStrategy[] = ['FIFO', 'LIFO', 'HIFO'];

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
  processDisposal = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

      // Validate types
      if (typeof quantity !== 'number' || quantity <= 0) {
        return next(Errors.validationError('quantity must be a positive number'));
      }
      if (typeof disposal_price_per_unit !== 'number' || disposal_price_per_unit < 0) {
        return next(Errors.validationError('disposal_price_per_unit must be a non-negative number'));
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
        quantity,
        strategy,
      });

      const result = await this.taxationService.processDisposal({
        investor_id: userId,
        offering_id,
        quantity,
        disposal_price_per_unit,
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
  previewDisposal = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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

      if (typeof quantity !== 'number' || quantity <= 0) {
        return next(Errors.validationError('quantity must be a positive number'));
      }
      if (typeof disposal_price_per_unit !== 'number' || disposal_price_per_unit < 0) {
        return next(Errors.validationError('disposal_price_per_unit must be a non-negative number'));
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
        quantity,
        strategy,
      });

      const result = await this.taxationService.previewDisposal({
        investor_id: userId,
        offering_id,
        quantity,
        disposal_price_per_unit,
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
   * Handle POST /taxation/lots
   *
   * Creates a new investment lot.
   */
  createLot = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const requestId = req.requestId;
      const userId = req.user?.id || req.user?.sub;

      if (!userId) {
        return next(Errors.unauthorized('User not authenticated'));
      }

      const {
        offering_id,
        investment_id,
        asset,
        quantity,
        cost_basis_per_unit,
        acquired_at,
        cost_currency,
        jurisdiction,
      } = req.body;

      if (!offering_id || !investment_id || !asset) {
        return next(Errors.validationError('Missing required fields: offering_id, investment_id, asset'));
      }

      if (typeof quantity !== 'number' || quantity <= 0) {
        return next(Errors.validationError('quantity must be a positive number'));
      }

      if (typeof cost_basis_per_unit !== 'number' || cost_basis_per_unit < 0) {
        return next(Errors.validationError('cost_basis_per_unit must be a non-negative number'));
      }

      const lot = await this.taxationService.createLot({
        investor_id: userId,
        offering_id,
        investment_id,
        asset,
        quantity,
        cost_basis_per_unit,
        acquired_at: acquired_at ? new Date(acquired_at) : new Date(),
        cost_currency,
        jurisdiction,
      });

      this.logger.info('Investment lot created', {
        requestId,
        userId,
        lotId: lot.id,
      });

      res.status(201).json({
        message: 'Investment lot created successfully',
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
