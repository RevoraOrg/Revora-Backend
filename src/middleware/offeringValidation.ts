/**
 * @title Validation Middleware
 * @dev Express middleware for offering validation matrix integration
 * 
 * This middleware provides seamless integration between the validation matrix
 * and existing Express routes, with proper error handling and response formatting.
 */

import { Request, Response, NextFunction } from 'express';
import { OfferingValidationService, createOfferingValidationService } from '../services/offeringValidationService';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { OfferingValidationContext, ValidationResult } from '../lib/validationMatrix';

/**
 * @dev Validation middleware configuration
 */
export interface ValidationMiddlewareConfig {
  offeringRepository: OfferingRepository;
  investmentRepository: InvestmentRepository;
  operation: 'create' | 'update' | 'status_change';
}

/**
 * @dev Extended request interface with validation data
 */
export interface ValidatedRequest extends Request {
  validationResult?: ValidationResult;
  offeringContext?: OfferingValidationContext;
}

/**
 * @dev Create validation middleware for specific operation
 * @param config Middleware configuration
 * @returns Express middleware function
 */
export function createValidationMiddleware(config: ValidationMiddlewareConfig) {
  const validationService = createOfferingValidationService(
    config.offeringRepository,
    config.investmentRepository
  );

  return async (req: ValidatedRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Build validation context
      const context = await buildValidationContext(req, config.operation);
      
      // Store context for later use
      req.offeringContext = context;

      // Execute validation
      const validationResult = await executeValidation(validationService, context, config.operation);
      
      // Store validation result
      req.validationResult = validationResult;

      // Handle validation failure
      if (!validationResult.isValid) {
        handleValidationFailure(res, validationResult);
        return;
      }

      // Log warnings if any
      if (validationResult.warnings.length > 0) {
        logValidationWarnings(validationResult);
      }

      next();
    } catch (error) {
      console.error('Validation middleware error:', error);
      res.status(500).json({
        error: 'Validation service unavailable',
        code: 'VALIDATION_SERVICE_ERROR'
      });
    }
  };
}

/**
 * @dev Build validation context from request
 * @param req Express request
 * @param operation Operation type
 * @returns Validation context
 */
async function buildValidationContext(req: Request, operation: string): Promise<OfferingValidationContext> {
  const user = (req as any).user || (req as any).auth;
  
  if (!user || !user.id) {
    throw new Error('User authentication required');
  }

  const context: OfferingValidationContext = {
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      created_at: user.created_at || new Date(),
      updated_at: user.updated_at || new Date()
    },
    requestPayload: req.body,
    operation: operation as any,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
    offeringData: {
      name: req.body.name,
      description: req.body.description,
      revenue_share_bps: req.body.revenue_share_bps,
      token_asset_id: req.body.token_asset_id,
      status: req.body.status
    }
  };

  // Add existing offering for update operations
  if (operation === 'update' || operation === 'status_change') {
    const offeringId = req.params.id;
    if (offeringId) {
      // This would be fetched from repository in a real implementation
      // context.offering = await offeringRepository.getById(offeringId);
    }
  }

  return context;
}

/**
 * @dev Execute validation based on operation type
 * @param validationService Validation service
 * @param context Validation context
 * @param operation Operation type
 * @returns Validation result
 */
async function executeValidation(
  validationService: OfferingValidationService,
  context: OfferingValidationContext,
  operation: string
): Promise<ValidationResult> {
  switch (operation) {
    case 'create':
      return validationService.validateOfferingCreation(context);
    case 'update':
      return validationService.validateOfferingUpdate(context);
    case 'status_change':
      return validationService.validateStatusChange(context);
    default:
      throw new Error(`Unsupported validation operation: ${operation}`);
  }
}

/**
 * @dev Handle validation failure with proper HTTP response
 * @param res Express response
 * @param result Validation result
 */
function handleValidationFailure(res: Response, result: ValidationResult): void {
  const statusCode = determineStatusCode(result);
  
  const response = {
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: result.errors.map(error => ({
      code: error.code,
      message: error.message,
      field: error.field,
      severity: error.severity,
      category: error.category,
      remediation: error.remediation
    })),
    warnings: result.warnings.map(warning => ({
      code: warning.code,
      message: warning.message,
      field: warning.field,
      category: warning.category
    })),
    metadata: {
      timestamp: result.metadata.timestamp,
      executionTimeMs: result.metadata.executionTimeMs,
      rulesApplied: result.metadata.rulesApplied
    }
  };

  res.status(statusCode).json(response);
}

/**
 * @dev Determine appropriate HTTP status code from validation errors
 * @param result Validation result
 * @returns HTTP status code
 */
function determineStatusCode(result: ValidationResult): number {
  // Critical security errors -> 403 Forbidden
  if (result.errors.some(e => e.severity === 'critical' && e.category === 'security')) {
    return 403;
  }

  // Authorization errors -> 401 Unauthorized
  if (result.errors.some(e => e.code === 'INSUFFICIENT_PRIVILEGES' || e.code === 'INVALID_USER')) {
    return 401;
  }

  // Not found errors -> 404 Not Found
  if (result.errors.some(e => e.code === 'OFFERING_NOT_FOUND')) {
    return 404;
  }

  // Business rule violations -> 422 Unprocessable Entity
  if (result.errors.some(e => e.category === 'business')) {
    return 422;
  }

  // Technical errors -> 400 Bad Request
  return 400;
}

/**
 * @dev Log validation warnings for monitoring
 * @param result Validation result
 */
function logValidationWarnings(result: ValidationResult): void {
  console.warn(`Validation warnings for request ${result.metadata.requestId}:`, {
    warnings: result.warnings,
    executionTime: result.metadata.executionTimeMs,
    rulesApplied: result.metadata.rulesApplied
  });
}

/**
 * @dev Convenience middleware creators for common operations
 */
export const validateOfferingCreation = (offeringRepository: OfferingRepository, investmentRepository: InvestmentRepository) =>
  createValidationMiddleware({
    offeringRepository,
    investmentRepository,
    operation: 'create'
  });

export const validateOfferingUpdate = (offeringRepository: OfferingRepository, investmentRepository: InvestmentRepository) =>
  createValidationMiddleware({
    offeringRepository,
    investmentRepository,
    operation: 'update'
  });

export const validateStatusChange = (offeringRepository: OfferingRepository, investmentRepository: InvestmentRepository) =>
  createValidationMiddleware({
    offeringRepository,
    investmentRepository,
    operation: 'status_change'
  });

/**
 * @dev Validation error handler middleware
 * @param err Error object
 * @param req Express request
 * @param res Express response
 * @param next Next function
 */
export function validationErrorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  if (err.name === 'ValidationError') {
    res.status(400).json({
      error: 'Validation error',
      message: err.message,
      code: 'VALIDATION_ERROR'
    });
    return;
  }

  next(err);
}
