/**
 * @title Offering Validation Service
 * @dev Service layer for offering validation with matrix integration
 * 
 * This service provides the interface between the validation matrix
 * and the existing offering endpoints, ensuring seamless integration
 * with minimal changes to existing code.
 */

import { OfferingValidationMatrix, ValidationContext, OfferingValidationContext, ValidationResult } from '../lib/validationMatrix';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { InvestmentRepository } from '../db/repositories/investmentRepository';

/**
 * @dev Offering validation service interface
 */
export interface OfferingValidationService {
  validateOfferingCreation(context: OfferingValidationContext): Promise<ValidationResult>;
  validateOfferingUpdate(context: OfferingValidationContext): Promise<ValidationResult>;
  validateStatusChange(context: OfferingValidationContext): Promise<ValidationResult>;
}

/**
 * @dev Production implementation of offering validation service
 */
export class ProductionOfferingValidationService implements OfferingValidationService {
  private validationMatrix: OfferingValidationMatrix;
  private offeringRepository: OfferingRepository;
  private investmentRepository: InvestmentRepository;

  constructor(
    offeringRepository: OfferingRepository,
    investmentRepository: InvestmentRepository
  ) {
    this.validationMatrix = new OfferingValidationMatrix();
    this.offeringRepository = offeringRepository;
    this.investmentRepository = investmentRepository;
  }

  /**
   * @dev Validate offering creation with full matrix
   * @param context Validation context for creation
   * @returns Validation result with detailed errors and warnings
   */
  async validateOfferingCreation(context: OfferingValidationContext): Promise<ValidationResult> {
    // Enrich context with existing offerings for duplicate checks
    const existingOfferings = await this.offeringRepository.getByUserId(context.user.id);
    context.existingOfferings = existingOfferings;
    context.operation = 'create';

    return this.validationMatrix.validateOffering(context);
  }

  /**
   * @dev Validate offering update with relevant rules
   * @param context Validation context for update
   * @returns Validation result with detailed errors and warnings
   */
  async validateOfferingUpdate(context: OfferingValidationContext): Promise<ValidationResult> {
    if (!context.offering) {
      return {
        isValid: false,
        errors: [{
          code: 'OFFERING_NOT_FOUND',
          message: 'Offering not found for update',
          severity: 'error',
          category: 'technical'
        }],
        warnings: [],
        metadata: {
          timestamp: new Date(),
          validationType: 'offering_update',
          executionTimeMs: 0,
          rulesApplied: []
        }
      };
    }

    // Check if offering has investments - restrict updates
    const investments = await this.investmentRepository.getByOfferingId(context.offering.id);
    if (investments.length > 0) {
      const restrictedFields = ['revenue_share_bps', 'token_asset_id'];
      for (const field of restrictedFields) {
        if (context.offeringData[field as keyof typeof context.offeringData] !== undefined) {
          return {
            isValid: false,
            errors: [{
              code: 'FIELD_NOT_UPDATABLE',
              message: `Cannot update ${field} after investments received`,
              field,
              severity: 'error',
              category: 'business'
            }],
            warnings: [],
            metadata: {
              timestamp: new Date(),
              validationType: 'offering_update',
              executionTimeMs: 0,
              rulesApplied: ['investment_restriction']
            }
          };
        }
      }
    }

    context.operation = 'update';
    return this.validationMatrix.validateOffering(context);
  }

  /**
   * @dev Validate status change with business rules
   * @param context Validation context for status change
   * @returns Validation result with detailed errors and warnings
   */
  async validateStatusChange(context: OfferingValidationContext): Promise<ValidationResult> {
    if (!context.offering) {
      return {
        isValid: false,
        errors: [{
          code: 'OFFERING_NOT_FOUND',
          message: 'Offering not found for status change',
          severity: 'error',
          category: 'technical'
        }],
        warnings: [],
        metadata: {
          timestamp: new Date(),
          validationType: 'status_change',
          executionTimeMs: 0,
          rulesApplied: []
        }
      };
    }

    // Additional business rules for status changes
    const investments = await this.investmentRepository.getByOfferingId(context.offering.id);
    
    // Can't close offering with active investments
    if (context.offeringData.status === 'closed' && investments.length > 0) {
      // Check if all distributions are complete
      const hasUndistributedRevenue = await this.hasUndistributedRevenue(context.offering.id);
      if (hasUndistributedRevenue) {
        return {
          isValid: false,
          errors: [{
            code: 'CANNOT_CLOSE_WITH_REVENUE',
            message: 'Cannot close offering with undistributed revenue',
            field: 'status',
            severity: 'error',
            category: 'business'
          }],
          warnings: [],
          metadata: {
            timestamp: new Date(),
            validationType: 'status_change',
            executionTimeMs: 0,
            rulesApplied: ['revenue_distribution_check']
          }
        };
      }
    }

    context.operation = 'status_change';
    return this.validationMatrix.validateOffering(context);
  }

  /**
   * @dev Check if offering has undistributed revenue
   * @param offeringId Offering ID to check
   * @returns True if undistributed revenue exists
   */
  private async hasUndistributedRevenue(offeringId: string): Promise<boolean> {
    // This would integrate with the revenue reporting and distribution systems
    // For now, return false as placeholder
    return false;
  }
}

/**
 * @dev Factory function for creating validation service
 * @param offeringRepository Offering repository
 * @param investmentRepository Investment repository
 * @returns Configured validation service
 */
export function createOfferingValidationService(
  offeringRepository: OfferingRepository,
  investmentRepository: InvestmentRepository
): OfferingValidationService {
  return new ProductionOfferingValidationService(offeringRepository, investmentRepository);
}
