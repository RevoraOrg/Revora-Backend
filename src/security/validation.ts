/**
 * Input validation and sanitization for milestone validation endpoints
 * 
 * Provides comprehensive validation with security-focused sanitization
 * to prevent injection attacks and ensure data integrity.
 */

import { Request, Response, NextFunction } from 'express';
import { ValidationError, SecurityContext } from './types';

/**
 * Validation schemas with strict type checking
 */
export interface ValidationSchema {
  [key: string]: {
    required?: boolean;
    type: 'string' | 'uuid' | 'email' | 'enum' | 'date';
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    enum?: string[];
    sanitize?: boolean;
  };
}

/**
 * Common validation schemas for milestone validation
 */
export const VALIDATION_SCHEMAS = {
  UUID: {
    type: 'uuid' as const,
    required: true,
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  },
  
  VAULT_ID: {
    type: 'string' as const,
    required: true,
    minLength: 1,
    maxLength: 255,
    pattern: /^[a-zA-Z0-9_-]+$/,
    sanitize: true,
  },
  
  MILESTONE_ID: {
    type: 'string' as const,
    required: true,
    minLength: 1,
    maxLength: 255,
    pattern: /^[a-zA-Z0-9_-]+$/,
    sanitize: true,
  },
  
  USER_ROLE: {
    type: 'enum' as const,
    required: false,
    enum: ['admin', 'verifier', 'issuer', 'investor'],
  },
};

/**
 * Validates and sanitizes a single value against a schema
 */
export const validateValue = (
  value: unknown,
  schema: ValidationSchema[string],
  fieldName: string
): string | null => {
  // Check if required field is missing
  if (schema.required && (value === undefined || value === null || value === '')) {
    throw new ValidationError(`Required field '${fieldName}' is missing`, {
      fieldName,
      received: value,
    });
  }

  // Allow optional fields to be empty
  if (!schema.required && (value === undefined || value === null || value === '')) {
    return null;
  }

  const stringValue = String(value);

  // Type validation
  switch (schema.type) {
    case 'uuid':
      if (!schema.pattern?.test(stringValue)) {
        throw new ValidationError(`Invalid UUID format for '${fieldName}'`, {
          fieldName,
          received: stringValue,
        });
      }
      break;

    case 'string':
      if (schema.minLength && stringValue.length < schema.minLength) {
        throw new ValidationError(`Field '${fieldName}' is too short`, {
          fieldName,
          received: stringValue,
          minLength: schema.minLength,
        });
      }
      if (schema.maxLength && stringValue.length > schema.maxLength) {
        throw new ValidationError(`Field '${fieldName}' is too long`, {
          fieldName,
          received: stringValue,
          maxLength: schema.maxLength,
        });
      }
      break;

    case 'enum':
      if (!schema.enum?.includes(stringValue)) {
        throw new ValidationError(`Invalid value for '${fieldName}'`, {
          fieldName,
          received: stringValue,
          allowedValues: schema.enum,
        });
      }
      break;

    case 'email':
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailPattern.test(stringValue)) {
        throw new ValidationError(`Invalid email format for '${fieldName}'`, {
          fieldName,
          received: stringValue,
        });
      }
      break;

    default:
      throw new ValidationError(`Unknown validation type for '${fieldName}'`, {
        fieldName,
        type: schema.type,
      });
  }

  // Pattern validation
  if (schema.pattern && !schema.pattern.test(stringValue)) {
    throw new ValidationError(`Field '${fieldName}' contains invalid characters`, {
      fieldName,
      received: stringValue,
      pattern: schema.pattern.toString(),
    });
  }

  // Sanitization
  if (schema.sanitize) {
    return sanitizeInput(stringValue);
  }

  return stringValue;
};

/**
 * Sanitizes input to prevent injection attacks
 */
export const sanitizeInput = (input: string): string => {
  return input
    // Remove potential script injections
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Trim whitespace
    .trim()
    // Remove null bytes
    .replace(/\0/g, '')
    // Remove control characters except newlines and tabs
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
};

/**
 * Validates request parameters against a schema
 */
export const validateParams = (
  params: Record<string, unknown>,
  schema: ValidationSchema
): Record<string, string> => {
  const validated: Record<string, string> = {};

  for (const [fieldName, fieldSchema] of Object.entries(schema)) {
    const value = validateValue(params[fieldName], fieldSchema, fieldName);
    if (value !== null) {
      validated[fieldName] = value;
    }
  }

  return validated;
};

/**
 * Middleware factory for parameter validation
 */
export const createValidationMiddleware = (
  schema: ValidationSchema,
  source: 'params' | 'query' | 'body' = 'params'
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const data = req[source] as Record<string, unknown>;
      const validated = validateParams(data, schema);
      
      // Store validated data back to request
      (req as any).validated = (req as any).validated || {};
      (req as any).validated[source] = validated;
      
      next();
    } catch (error) {
      const securityContext = (req as any).securityContext as SecurityContext;
      
      if (error instanceof ValidationError) {
        res.status(400).json({
          error: 'Validation failed',
          code: error.code,
          details: error.details,
          requestId: securityContext?.requestId,
        });
      } else {
        res.status(500).json({
          error: 'Internal validation error',
          requestId: securityContext?.requestId,
        });
      }
    }
  };
};

/**
 * Specific validation middleware for milestone validation endpoints
 */
export const validateMilestoneValidationParams = createValidationMiddleware({
  id: VALIDATION_SCHEMAS.VAULT_ID,
  mid: VALIDATION_SCHEMAS.MILESTONE_ID,
});

/**
 * Validates that a user has the verifier role and is properly authenticated
 */
export const validateVerifierRole = (
  req: Request,
  securityContext: SecurityContext
): void => {
  if (securityContext.user.role !== 'verifier') {
    throw new ValidationError('User must have verifier role', {
      userRole: securityContext.user.role,
      requiredRole: 'verifier',
    });
  }
};

/**
 * Validates concurrent validation limits to prevent abuse
 */
export interface ValidationLimiter {
  checkConcurrentValidations(vaultId: string, verifierId: string): Promise<boolean>;
  releaseValidation(vaultId: string, verifierId: string): Promise<void>;
}

/**
 * In-memory implementation of validation limiter for development
 * In production, this should use Redis or another distributed cache
 */
export class InMemoryValidationLimiter implements ValidationLimiter {
  private activeValidations = new Map<string, Set<string>>();
  private maxConcurrent = 5;

  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  async checkConcurrentValidations(vaultId: string, verifierId: string): Promise<boolean> {
    const vaultValidations = this.activeValidations.get(vaultId) || new Set();
    
    if (vaultValidations.size >= this.maxConcurrent) {
      return false;
    }

    vaultValidations.add(verifierId);
    this.activeValidations.set(vaultId, vaultValidations);
    return true;
  }

  async releaseValidation(vaultId: string, verifierId: string): Promise<void> {
    const vaultValidations = this.activeValidations.get(vaultId);
    if (vaultValidations) {
      vaultValidations.delete(verifierId);
      if (vaultValidations.size === 0) {
        this.activeValidations.delete(vaultId);
      }
    }
  }
}

/**
 * Middleware for concurrent validation limiting
 */
export const createValidationLimiterMiddleware = (limiter: ValidationLimiter) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const securityContext = (req as any).securityContext as SecurityContext;
    const { id: vaultId, mid: milestoneId } = (req as any).validated?.params || {};

    if (!vaultId || !securityContext) {
      res.status(400).json({
        error: 'Invalid request: missing vault ID or authentication',
        requestId: securityContext?.requestId,
      });
      return;
    }

    try {
      const canProceed = await limiter.checkConcurrentValidations(
        vaultId,
        securityContext.user.id
      );

      if (!canProceed) {
        res.status(429).json({
          error: 'Too many concurrent validations for this vault',
          requestId: securityContext.requestId,
        });
        return;
      }

      // Store limiter reference for cleanup in error handling
      (req as any).validationLimiter = limiter;
      
      next();
    } catch (error) {
      res.status(500).json({
        error: 'Validation limiter error',
        requestId: securityContext.requestId,
      });
    }
  };
};
