/**
 * @title Offering Validation Matrix
 * @dev Production-grade validation framework for Stellar RevenueShare offerings
 * 
 * This module provides a comprehensive validation matrix for offering operations
 * with deterministic behavior, security assumptions, and audit trails.
 * 
 * Security Assumptions:
 * - All inputs are untrusted and must be validated
 * - Authentication is handled separately but role-based access is enforced
 * - Rate limiting and request size limits are applied upstream
 * - Database transactions ensure atomicity
 * 
 * Threat Model:
 * - Injection attacks through malicious input
 * - Privilege escalation through role manipulation
 * - Resource exhaustion through large payloads
 * - Race conditions in concurrent operations
 */

import { Offering, User } from '../types';

/**
 * @dev Validation result interface with detailed error reporting
 */
export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  metadata: ValidationMetadata;
}

/**
 * @dev Detailed validation error with security context
 */
export interface ValidationError {
  code: string;
  message: string;
  field?: string;
  severity: 'error' | 'critical';
  category: 'security' | 'business' | 'technical' | 'compliance';
  remediation?: string;
}

/**
 * @dev Validation warning for non-blocking issues
 */
export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
  category: 'performance' | 'business' | 'security';
}

/**
 * @dev Validation metadata for audit and debugging
 */
export interface ValidationMetadata {
  timestamp: Date;
  validationType: string;
  userId?: string;
  requestId?: string;
  executionTimeMs: number;
  rulesApplied: string[];
}

/**
 * @dev Validation context containing all necessary data for validation
 */
export interface ValidationContext {
  user: User;
  offering?: Offering;
  existingOfferings?: Offering[];
  requestPayload: Record<string, any>;
  operation: 'create' | 'update' | 'delete' | 'status_change';
  ipAddress?: string;
  userAgent?: string;
}

/**
 * @dev Validation rule interface for extensible rule system
 */
export interface ValidationRule {
  name: string;
  description: string;
  category: 'security' | 'business' | 'technical' | 'compliance';
  priority: number;
  validate: (context: ValidationContext) => Promise<ValidationRuleResult>;
  isRequired: boolean;
}

/**
 * @dev Individual rule result
 */
export interface ValidationRuleResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * @dev Offering-specific validation context
 */
export interface OfferingValidationContext extends ValidationContext {
  operation: 'create' | 'update' | 'status_change';
  offeringData: {
    name?: string;
    description?: string;
    revenue_share_bps?: number;
    token_asset_id?: string;
    status?: string;
  };
}

/**
 * @dev Main validation matrix engine
 * 
 * Provides deterministic, secure validation for all offering operations
 * with comprehensive error reporting and audit trails.
 */
export class OfferingValidationMatrix {
  private rules: Map<string, ValidationRule> = new Map();
  private ruleSets: Map<string, string[]> = new Map();

  constructor() {
    this.initializeDefaultRules();
    this.initializeRuleSets();
  }

  /**
   * @dev Validate offering operation with full matrix
   * @param context Validation context with all necessary data
   * @returns Comprehensive validation result
   */
  async validateOffering(context: OfferingValidationContext): Promise<ValidationResult> {
    const startTime = Date.now();
    const ruleSet = this.getRuleSetForOperation(context.operation);
    
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const rulesApplied: string[] = [];

    // Execute rules in priority order
    for (const ruleName of ruleSet) {
      const rule = this.rules.get(ruleName);
      if (!rule) {
        continue;
      }

      try {
        const result = await rule.validate(context);
        rulesApplied.push(rule.name);
        
        errors.push(...result.errors);
        warnings.push(...result.warnings);

        // Fail fast on critical security errors
        if (result.errors.some(e => e.severity === 'critical' && e.category === 'security')) {
          break;
        }
      } catch (error) {
        // Log validation engine errors but don't fail validation
        console.error(`Validation rule '${rule.name}' failed:`, error);
        errors.push({
          code: 'VALIDATION_ENGINE_ERROR',
          message: 'Internal validation error',
          severity: 'error',
          category: 'technical',
          remediation: 'Contact support with request ID'
        });
      }
    }

    const executionTime = Date.now() - startTime;

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      metadata: {
        timestamp: new Date(),
        validationType: 'offering_validation',
        userId: context.user.id,
        requestId: context.requestPayload.requestId,
        executionTimeMs: executionTime,
        rulesApplied
      }
    };
  }

  /**
   * @dev Add custom validation rule
   * @param rule Validation rule to add
   */
  addRule(rule: ValidationRule): void {
    this.rules.set(rule.name, rule);
  }

  /**
   * @dev Get rule set for specific operation
   * @param operation Operation type
   * @returns Array of rule names in priority order
   */
  private getRuleSetForOperation(operation: string): string[] {
    return this.ruleSets.get(operation) || [];
  }

  /**
   * @dev Initialize default validation rules
   */
  private initializeDefaultRules(): void {
    // Security Rules
    this.addRule({
      name: 'input_sanitization',
      description: 'Sanitize and validate all input fields',
      category: 'security',
      priority: 1,
      isRequired: true,
      validate: this.validateInputSanitization.bind(this)
    });

    this.addRule({
      name: 'role_authorization',
      description: 'Validate user role permissions',
      category: 'security',
      priority: 2,
      isRequired: true,
      validate: this.validateRoleAuthorization.bind(this)
    });

    this.addRule({
      name: 'rate_limit_check',
      description: 'Check rate limits for abuse prevention',
      category: 'security',
      priority: 3,
      isRequired: true,
      validate: this.validateRateLimits.bind(this)
    });

    // Business Rules
    this.addRule({
      name: 'offering_name_validation',
      description: 'Validate offering name requirements',
      category: 'business',
      priority: 10,
      isRequired: true,
      validate: this.validateOfferingName.bind(this)
    });

    this.addRule({
      name: 'revenue_share_validation',
      description: 'Validate revenue share percentage',
      category: 'business',
      priority: 11,
      isRequired: true,
      validate: this.validateRevenueShare.bind(this)
    });

    this.addRule({
      name: 'token_asset_validation',
      description: 'Validate token asset identifier',
      category: 'business',
      priority: 12,
      isRequired: true,
      validate: this.validateTokenAsset.bind(this)
    });

    this.addRule({
      name: 'status_transition_validation',
      description: 'Validate status transition rules',
      category: 'business',
      priority: 13,
      isRequired: true,
      validate: this.validateStatusTransition.bind(this)
    });

    // Technical Rules
    this.addRule({
      name: 'payload_size_validation',
      description: 'Validate request payload size',
      category: 'technical',
      priority: 20,
      isRequired: true,
      validate: this.validatePayloadSize.bind(this)
    });

    this.addRule({
      name: 'duplicate_offering_check',
      description: 'Check for duplicate offerings',
      category: 'technical',
      priority: 21,
      isRequired: true,
      validate: this.validateDuplicateOffering.bind(this)
    });
  }

  /**
   * @dev Initialize rule sets for different operations
   */
  private initializeRuleSets(): void {
    this.ruleSets.set('create', [
      'input_sanitization',
      'role_authorization', 
      'rate_limit_check',
      'payload_size_validation',
      'offering_name_validation',
      'revenue_share_validation',
      'token_asset_validation',
      'duplicate_offering_check'
    ]);

    this.ruleSets.set('update', [
      'input_sanitization',
      'role_authorization',
      'rate_limit_check',
      'payload_size_validation',
      'offering_name_validation',
      'revenue_share_validation',
      'token_asset_validation'
    ]);

    this.ruleSets.set('status_change', [
      'input_sanitization',
      'role_authorization',
      'rate_limit_check',
      'status_transition_validation'
    ]);
  }

  // Validation Rule Implementations

  /**
   * @dev Validate input sanitization and prevent injection attacks
   */
  private async validateInputSanitization(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const { offeringData } = context;

    // Check for SQL injection patterns
    const sqlPatterns = [/(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b)/i, /(\b(UNION|OR|AND)\b.*\b(=|LIKE)\b)/i];
    
    if (offeringData.name) {
      for (const pattern of sqlPatterns) {
        if (pattern.test(offeringData.name)) {
          errors.push({
            code: 'SQL_INJECTION_DETECTED',
            message: 'Invalid characters detected in offering name',
            field: 'name',
            severity: 'critical',
            category: 'security',
            remediation: 'Remove SQL keywords and special characters'
          });
        }
      }
    }

    // Check for XSS patterns
    const xssPatterns = [/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, /javascript:/i];
    
    if (offeringData.description) {
      for (const pattern of xssPatterns) {
        if (pattern.test(offeringData.description)) {
          errors.push({
            code: 'XSS_PATTERN_DETECTED',
            message: 'Invalid script content detected in description',
            field: 'description',
            severity: 'critical',
            category: 'security',
            remediation: 'Remove script tags and JavaScript URLs'
          });
        }
      }
    }

    // Validate field lengths
    if (offeringData.name && offeringData.name.length > 255) {
      errors.push({
        code: 'FIELD_TOO_LONG',
        message: 'Offering name exceeds maximum length',
        field: 'name',
        severity: 'error',
        category: 'technical'
      });
    }

    if (offeringData.description && offeringData.description.length > 5000) {
      warnings.push({
        code: 'LONG_DESCRIPTION',
        message: 'Description is very long, consider shortening',
        field: 'description',
        category: 'performance'
      });
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * @dev Validate user role authorization for operation
   */
  private async validateRoleAuthorization(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { user, operation } = context;

    // Only startup users can create offerings
    if (operation === 'create' && user.role !== 'startup') {
      errors.push({
        code: 'INSUFFICIENT_PRIVILEGES',
        message: 'Only startup users can create offerings',
        severity: 'critical',
        category: 'security',
        remediation: 'Contact admin to upgrade account to startup role'
      });
    }

    // Validate user is active
    if (!user.id) {
      errors.push({
        code: 'INVALID_USER',
        message: 'User authentication required',
        severity: 'critical',
        category: 'security'
      });
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * @dev Validate rate limits for abuse prevention
   */
  private async validateRateLimits(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    // In production, this would integrate with a rate limiting service
    // For now, we'll implement basic checks
    
    const { user, operation } = context;

    // Check for excessive creation attempts
    if (operation === 'create' && context.existingOfferings && context.existingOfferings.length > 10) {
      warnings.push({
        code: 'MANY_OFFERINGS',
        message: 'User has many existing offerings',
        category: 'business'
      });
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * @dev Validate offering name business rules
   */
  private async validateOfferingName(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { offeringData } = context;

    if (!offeringData.name || offeringData.name.trim().length === 0) {
      errors.push({
        code: 'NAME_REQUIRED',
        message: 'Offering name is required',
        field: 'name',
        severity: 'error',
        category: 'business'
      });
    } else {
      const name = offeringData.name.trim();
      
      if (name.length < 3) {
        errors.push({
          code: 'NAME_TOO_SHORT',
          message: 'Offering name must be at least 3 characters',
          field: 'name',
          severity: 'error',
          category: 'business'
        });
      }

      if (!/^[a-zA-Z0-9\s\-_.]+$/.test(name)) {
        errors.push({
          code: 'INVALID_NAME_CHARS',
          message: 'Offering name contains invalid characters',
          field: 'name',
          severity: 'error',
          category: 'business'
        });
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * @dev Validate revenue share percentage
   */
  private async validateRevenueShare(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { offeringData } = context;

    if (offeringData.revenue_share_bps !== undefined) {
      if (typeof offeringData.revenue_share_bps !== 'number') {
        errors.push({
          code: 'INVALID_REVENUE_SHARE_TYPE',
          message: 'Revenue share must be a number',
          field: 'revenue_share_bps',
          severity: 'error',
          category: 'business'
        });
      } else if (offeringData.revenue_share_bps < 0 || offeringData.revenue_share_bps > 10000) {
        errors.push({
          code: 'REVENUE_SHARE_OUT_OF_RANGE',
          message: 'Revenue share must be between 0 and 10000 basis points (0-100%)',
          field: 'revenue_share_bps',
          severity: 'error',
          category: 'business'
        });
      } else if (offeringData.revenue_share_bps > 5000) {
        errors.push({
          code: 'HIGH_REVENUE_SHARE',
          message: 'Revenue share exceeds 50%, this may not be attractive to investors',
          field: 'revenue_share_bps',
          severity: 'error',
          category: 'business'
        });
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * @dev Validate token asset identifier
   */
  private async validateTokenAsset(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { offeringData } = context;

    if (!offeringData.token_asset_id || offeringData.token_asset_id.trim().length === 0) {
      errors.push({
        code: 'TOKEN_ASSET_REQUIRED',
        message: 'Token asset ID is required',
        field: 'token_asset_id',
        severity: 'error',
        category: 'business'
      });
    } else {
      const assetId = offeringData.token_asset_id.trim();
      
      if (assetId.length > 255) {
        errors.push({
          code: 'TOKEN_ASSET_TOO_LONG',
          message: 'Token asset ID exceeds maximum length',
          field: 'token_asset_id',
          severity: 'error',
          category: 'technical'
        });
      }

      // Basic Stellar asset format validation
      if (!/^[a-zA-Z0-9]{1,12}$/.test(assetId)) {
        errors.push({
          code: 'INVALID_TOKEN_FORMAT',
          message: 'Token asset ID must be 1-12 alphanumeric characters',
          field: 'token_asset_id',
          severity: 'error',
          category: 'business'
        });
      }
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * @dev Validate status transition rules
   */
  private async validateStatusTransition(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { offering, offeringData } = context;

    if (!offering || !offeringData.status) {
      return { isValid: true, errors, warnings: [] };
    }

    const currentStatus = offering.status;
    const newStatus = offeringData.status;

    // Define valid status transitions
    const validTransitions: Record<string, string[]> = {
      'draft': ['active', 'closed'],
      'active': ['paused', 'closed'],
      'paused': ['active', 'closed'],
      'closed': []
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      errors.push({
        code: 'INVALID_STATUS_TRANSITION',
        message: `Cannot transition from ${currentStatus} to ${newStatus}`,
        field: 'status',
        severity: 'error',
        category: 'business'
      });
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }

  /**
   * @dev Validate request payload size
   */
  private async validatePayloadSize(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const payloadSize = JSON.stringify(context.requestPayload).length;
    const maxSize = 1024 * 1024; // 1MB

    if (payloadSize > maxSize) {
      errors.push({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request payload exceeds maximum size',
        severity: 'error',
        category: 'technical'
      });
    }

    if (payloadSize > maxSize * 0.8) {
      warnings.push({
        code: 'LARGE_PAYLOAD',
        message: 'Request payload is approaching size limit',
        category: 'performance'
      });
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * @dev Check for duplicate offerings
   */
  private async validateDuplicateOffering(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const { user, offeringData, existingOfferings } = context;

    if (!offeringData.name || !existingOfferings) {
      return { isValid: true, errors, warnings: [] };
    }

    const duplicateName = existingOfferings.find(
      offering => offering.name === offeringData.name && offering.issuer_user_id === user.id
    );

    if (duplicateName) {
      errors.push({
        code: 'DUPLICATE_OFFERING_NAME',
        message: 'An offering with this name already exists',
        field: 'name',
        severity: 'error',
        category: 'business'
      });
    }

    return { isValid: errors.length === 0, errors, warnings: [] };
  }
}
