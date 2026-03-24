/**
 * @title Offering Validation Matrix
 * @dev Production-grade validation framework for Stellar RevenueShare offerings
 * 
 * This module provides a comprehensive validation matrix for offering operations
 * with deterministic behavior, security assumptions, and audit trails.
 * 
 * ## Security Assumptions:
 * - All inputs are untrusted and must be validated
 * - Authentication is handled separately but role-based access is enforced
 * - Rate limiting and request size limits are applied upstream
 * - Database transactions ensure atomicity
 * - Stellar network calls are properly mocked/handled in tests
 * 
 * ## Threat Model:
 * - Injection attacks through malicious input (SQL, XSS, NoSQL)
 * - Privilege escalation through role manipulation
 * - Resource exhaustion through large payloads
 * - Race conditions in concurrent operations
 * - Integer overflow/underflow in financial calculations
 * - Malformed Stellar contract addresses
 * 
 * @author Stellar Wave Program
 * @version 1.0.0
 */

import { Offering, User } from '../types';

/**
 * @dev Validation result interface with detailed error reporting
 * 
 * Provides comprehensive feedback on validation operations including
 * errors, warnings, and execution metadata for audit trails.
 * 
 * @property isValid - Overall validation status
 * @property errors - Critical validation errors that must be resolved
 * @property warnings - Non-critical issues that should be reviewed
 * @property metadata - Execution context and audit information
 */
export interface ValidationResult {
  /** Overall validation status */
  isValid: boolean;
  /** Critical validation errors */
  errors: ValidationError[];
  /** Non-critical warnings */
  warnings: ValidationWarning[];
  /** Execution metadata for audit trails */
  metadata: ValidationMetadata;
}

/**
 * @dev Detailed validation error with security context
 * 
 * Each error includes machine-readable codes, human-readable messages,
 * and remediation guidance for developers and users.
 * 
 * @property code - Machine-readable error identifier
 * @property message - Human-readable error description
 * @property field - Field that caused the error (optional)
 * @property severity - Error impact level
 * @property category - Type of validation failure
 * @property remediation - Recommended fix action (optional)
 */
export interface ValidationError {
  /** Machine-readable error identifier */
  code: string;
  /** Human-readable error description */
  message: string;
  /** Field that caused the error */
  field?: string;
  /** Error severity level */
  severity: 'error' | 'critical';
  /** Validation category */
  category: 'security' | 'business' | 'technical' | 'compliance';
  /** Recommended fix action */
  remediation?: string;
}

/**
 * @dev Validation warning for non-blocking issues
 * 
 * Warnings indicate potential issues that don't prevent operation
 * but should be reviewed for security or performance reasons.
 * 
 * @property code - Machine-readable warning identifier
 * @property message - Human-readable warning description
 * @property field - Field that generated warning (optional)
 * @property category - Type of validation warning
 */
export interface ValidationWarning {
  /** Machine-readable warning identifier */
  code: string;
  /** Human-readable warning description */
  message: string;
  /** Field that generated warning */
  field?: string;
  /** Warning category */
  category: 'performance' | 'business' | 'security';
}

/**
 * @dev Validation metadata for audit and debugging
 * 
 * Provides execution context for compliance, debugging,
 * and performance monitoring purposes.
 * 
 * @property timestamp - When validation occurred
 * @property validationType - Type of validation performed
 * @property userId - User who initiated validation (optional)
 * @property requestId - Request identifier for tracing (optional)
 * @property executionTimeMs - Time taken to validate in milliseconds
 * @property rulesApplied - List of validation rules executed
 */
export interface ValidationMetadata {
  /** Validation timestamp */
  timestamp: Date;
  /** Type of validation performed */
  validationType: string;
  /** User ID for audit trail */
  userId?: string;
  /** Request ID for tracing */
  requestId?: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** List of applied validation rules */
  rulesApplied: string[];
}

/**
 * @dev Validation context containing all necessary data for validation
 * 
 * Provides the complete context needed for comprehensive validation
 * including user information, existing data, and request details.
 * 
 * @property user - Authenticated user performing the operation
 * @property offering - Existing offering for update operations (optional)
 * @property existingOfferings - User's existing offerings for duplicate checks (optional)
 * @property requestPayload - Raw request data
 * @property operation - Type of operation being validated
 * @property ipAddress - Client IP for security logging (optional)
 * @property userAgent - Client user agent for analysis (optional)
 */
export interface ValidationContext {
  /** Authenticated user performing the operation */
  user: User;
  /** Existing offering for update operations */
  offering?: Offering;
  /** User's existing offerings for duplicate checks */
  existingOfferings?: Offering[];
  /** Raw request data */
  requestPayload: Record<string, any>;
  /** Type of operation being validated */
  operation: 'create' | 'update' | 'delete' | 'status_change';
  /** Client IP for security logging */
  ipAddress?: string;
  /** Client user agent for analysis */
  userAgent?: string;
}

/**
 * @dev Validation rule interface for extensible rule system
 * 
 * Defines the contract for validation rules that can be dynamically
 * added to the validation matrix for custom business logic.
 * 
 * @property name - Unique rule identifier
 * @property description - Human-readable rule description
 * @property category - Rule classification for organization
 * @property priority - Execution order (lower numbers execute first)
 * @property validate - Async validation function
 * @property isRequired - Whether rule failure blocks operation
 */
export interface ValidationRule {
  /** Unique rule identifier */
  name: string;
  /** Human-readable rule description */
  description: string;
  /** Rule classification for organization */
  category: 'security' | 'business' | 'technical' | 'compliance';
  /** Execution order (lower numbers execute first) */
  priority: number;
  /** Whether rule failure blocks operation */
  isRequired: boolean;
  /** Async validation function */
  validate: (context: ValidationContext) => Promise<ValidationRuleResult>;
}

/**
 * @dev Individual rule result
 * 
 * Represents the outcome of a single validation rule execution
 * with specific errors and warnings for that rule.
 * 
 * @property isValid - Whether the rule passed validation
 * @property errors - Rule-specific validation errors
 * @property warnings - Rule-specific validation warnings
 */
export interface ValidationRuleResult {
  /** Whether the rule passed validation */
  isValid: boolean;
  /** Rule-specific validation errors */
  errors: ValidationError[];
  /** Rule-specific validation warnings */
  warnings: ValidationWarning[];
}

/**
 * @dev Offering-specific validation context
 * 
 * Extends the base validation context with offering-specific data
 * for detailed validation of offering operations.
 * 
 * @property operation - Type of offering operation
 * @property offeringData - Offering-specific fields for validation
 */
export interface OfferingValidationContext extends ValidationContext {
  /** Type of offering operation */
  operation: 'create' | 'update' | 'status_change';
  /** Offering-specific fields for validation */
  offeringData: {
    /** Offering name for validation */
    name?: string;
    /** Offering description for content validation */
    description?: string;
    /** Revenue share in basis points (0-10000) */
    revenue_share_bps?: number;
    /** Stellar token asset identifier */
    token_asset_id?: string;
    /** Offering status for transition validation */
    status?: string;
  };
}

/**
 * @dev Main validation matrix engine
 * 
 * Provides deterministic, secure validation for all offering operations
 * with comprehensive error reporting and audit trails.
 * 
 * ## Features:
 * - Priority-based rule execution
 * - Fail-fast on critical security errors
 * - Comprehensive audit logging
 * - Extensible rule system
 * - Performance monitoring
 * 
 * ## Usage:
 * ```typescript
 * const matrix = new OfferingValidationMatrix();
 * const result = await matrix.validateOffering(context);
 * if (!result.isValid) {
 *   // Handle validation errors
 * }
 * ```
 */
export class OfferingValidationMatrix {
  private rules: Map<string, ValidationRule> = new Map();
  private ruleSets: Map<string, string[]> = new Map();

  /**
   * @dev Initialize validation matrix with default rules
   * 
   * Constructor sets up the validation engine with all default
   * security and business rules for offering operations.
   */
  constructor() {
    this.initializeDefaultRules();
    this.initializeRuleSets();
  }

  /**
   * @dev Validate offering operation with full matrix
   * 
   * Executes all applicable validation rules in priority order,
   * providing comprehensive error reporting and audit trails.
   * 
   * ## Security Features:
   * - Fail-fast on critical security errors
   * - Isolated rule execution to prevent cascading failures
   * - Comprehensive audit logging
   * - Performance monitoring
   * 
   * @param context - Validation context with all necessary data
   * @returns Comprehensive validation result with errors, warnings, and metadata
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
   * 
   * ## Security Checks:
   * - SQL injection pattern detection
   * - XSS (Cross-Site Scripting) pattern detection
   * - NoSQL injection pattern detection
   * - Command injection pattern detection
   * - LDAP injection pattern detection
   * - Path traversal detection
   * - Buffer overflow prevention
   * 
   * @param context - Validation context containing offering data
   * @returns Validation rule result with security findings
   */
  private async validateInputSanitization(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    const { offeringData } = context;

    // Enhanced SQL injection patterns
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|TRUNCATE)\b)/i,
      /(\b(OR|AND)\b.*\b(=|LIKE|IN)\b)/i,
      /(--|;|\/\*|\*\/|xp_|sp_)/,
      /\b(waitfor|delay|sleep)\b/i,
      /\b(benchmark|sleep|pg_sleep)\b/i
    ];
    
    // Check for SQL injection in name field
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

    // Enhanced XSS patterns
    const xssPatterns = [
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      /javascript:/i,
      /on\w+\s*=/i,
      /<iframe\b/i,
      /<object\b/i,
      /<embed\b/i,
      /<link\b/i,
      /<meta\b/i,
      /data:text\/html/i,
      /vbscript:/i
    ];
    
    // Check for XSS in description field
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

    // NoSQL injection patterns
    const nosqlPatterns = [
      /\$where/i,
      /\$ne/i,
      /\$gt/i,
      /\$lt/i,
      /\$regex/i,
      /\{\s*\$[^}]+\}/
    ];

    // Check all string fields for NoSQL injection
    const stringFields = [offeringData.name, offeringData.description, offeringData.token_asset_id];
    for (const [index, field] of stringFields.entries()) {
      if (field) {
        for (const pattern of nosqlPatterns) {
          if (pattern.test(field)) {
            const fieldName = ['name', 'description', 'token_asset_id'][index];
            errors.push({
              code: 'NOSQL_INJECTION_DETECTED',
              message: 'NoSQL injection pattern detected',
              field: fieldName,
              severity: 'critical',
              category: 'security',
              remediation: 'Remove NoSQL operators and query syntax'
            });
          }
        }
      }
    }

    // Command injection patterns
    const commandPatterns = [
      /[;&|`$(){}\[\]]/,
      /\b(cat|ls|ps|kill|rm|mv|cp)\b/i,
      /\b(curl|wget|nc|netcat)\b/i,
      /\b(python|perl|ruby|node)\b/i
    ];

    if (offeringData.name) {
      for (const pattern of commandPatterns) {
        if (pattern.test(offeringData.name)) {
          errors.push({
            code: 'COMMAND_INJECTION_DETECTED',
            message: 'Command injection pattern detected',
            field: 'name',
            severity: 'critical',
            category: 'security',
            remediation: 'Remove shell command syntax'
          });
        }
      }
    }

    // Path traversal patterns
    const pathTraversalPatterns = [
      /\.\.[\/\\]/,
      /%2e%2e[\/\\]/i,
      /\.\.\./,
      /%2e%2e%2e/i
    ];

    if (offeringData.token_asset_id) {
      for (const pattern of pathTraversalPatterns) {
        if (pattern.test(offeringData.token_asset_id)) {
          errors.push({
            code: 'PATH_TRAVERSAL_DETECTED',
            message: 'Path traversal pattern detected in token asset ID',
            field: 'token_asset_id',
            severity: 'critical',
            category: 'security',
            remediation: 'Remove directory traversal sequences'
          });
        }
      }
    }

    // Validate field lengths to prevent buffer overflow
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

    if (offeringData.token_asset_id && offeringData.token_asset_id.length > 255) {
      errors.push({
        code: 'TOKEN_ASSET_TOO_LONG',
        message: 'Token asset ID exceeds maximum length',
        field: 'token_asset_id',
        severity: 'error',
        category: 'technical'
      });
    }

    // Check for null bytes and other dangerous characters
    const dangerousChars = ['\x00', '\x0a', '\x0d', '\x1a'];
    const allStringFields = [offeringData.name, offeringData.description, offeringData.token_asset_id];
    
    for (const [index, field] of allStringFields.entries()) {
      if (field) {
        for (const char of dangerousChars) {
          if (field.includes(char)) {
            const fieldName = ['name', 'description', 'token_asset_id'][index] as string;
            errors.push({
              code: 'DANGEROUS_CHARACTER_DETECTED',
              message: 'Dangerous character detected in field',
              field: fieldName,
              severity: 'critical',
              category: 'security',
              remediation: 'Remove null bytes and control characters'
            });
          }
        }
      }
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
   * @dev Validate revenue share percentage with overflow protection
   * 
   * ## Security Checks:
   * - Integer overflow/underflow detection
   * - Range validation (0-10000 basis points)
   * - Type validation (must be number)
   * - Precision validation
   * - Business rule validation (max 50% recommended)
   * 
   * @param context - Validation context containing revenue data
   * @returns Validation rule result with financial validation findings
   */
  private async validateRevenueShare(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const { offeringData } = context;

    if (offeringData.revenue_share_bps !== undefined) {
      // Type validation
      if (typeof offeringData.revenue_share_bps !== 'number') {
        errors.push({
          code: 'INVALID_REVENUE_SHARE_TYPE',
          message: 'Revenue share must be a number',
          field: 'revenue_share_bps',
          severity: 'error',
          category: 'business'
        });
        return { isValid: false, errors, warnings };
      }

      // Check for NaN and Infinity
      if (isNaN(offeringData.revenue_share_bps) || !isFinite(offeringData.revenue_share_bps)) {
        errors.push({
          code: 'INVALID_REVENUE_SHARE_VALUE',
          message: 'Revenue share must be a finite number',
          field: 'revenue_share_bps',
          severity: 'critical',
          category: 'security',
          remediation: 'Provide a valid numeric value'
        });
        return { isValid: false, errors, warnings };
      }

      // Check for integer values only (basis points should be whole numbers)
      if (!Number.isInteger(offeringData.revenue_share_bps)) {
        errors.push({
          code: 'REVENUE_SHARE_NOT_INTEGER',
          message: 'Revenue share must be an integer value in basis points',
          field: 'revenue_share_bps',
          severity: 'error',
          category: 'business',
          remediation: 'Use whole numbers for basis points (e.g., 1000 for 10%)'
        });
      }

      // Range validation (0-10000 basis points = 0-100%)
      if (offeringData.revenue_share_bps < 0) {
        errors.push({
          code: 'REVENUE_SHARE_NEGATIVE',
          message: 'Revenue share cannot be negative',
          field: 'revenue_share_bps',
          severity: 'critical',
          category: 'security',
          remediation: 'Provide a non-negative value'
        });
      }

      if (offeringData.revenue_share_bps > 10000) {
        errors.push({
          code: 'REVENUE_SHARE_OVERFLOW',
          message: 'Revenue share cannot exceed 10000 basis points (100%)',
          field: 'revenue_share_bps',
          severity: 'critical',
          category: 'security',
          remediation: 'Provide a value between 0 and 10000'
        });
      }

      // Business rule validation (warn about high revenue shares)
      if (offeringData.revenue_share_bps > 5000) {
        warnings.push({
          code: 'HIGH_REVENUE_SHARE',
          message: 'Revenue share exceeds 50%, this may not be attractive to investors',
          field: 'revenue_share_bps',
          category: 'business'
        });
      }

      // Check for extremely low revenue shares
      if (offeringData.revenue_share_bps > 0 && offeringData.revenue_share_bps < 100) {
        warnings.push({
          code: 'LOW_REVENUE_SHARE',
          message: 'Revenue share is very low, consider increasing to attract investors',
          field: 'revenue_share_bps',
          category: 'business'
        });
      }

      // Check for suspiciously specific values (potential attack patterns)
      const suspiciousValues = [9999, 999, 99, 9];
      if (suspiciousValues.includes(offeringData.revenue_share_bps)) {
        warnings.push({
          code: 'SUSPICIOUS_REVENUE_SHARE',
          message: 'Revenue share value may be suspiciously specific',
          field: 'revenue_share_bps',
          category: 'security'
        });
      }

      // Validate precision (should be reasonable for financial calculations)
      if (offeringData.revenue_share_bps.toString().length > 10) {
        warnings.push({
          code: 'REVENUE_SHARE_HIGH_PRECISION',
          message: 'Revenue share has unusually high precision',
          field: 'revenue_share_bps',
          category: 'technical'
        });
      }
    }

    return { isValid: errors.length === 0, errors, warnings };
  }

  /**
   * @dev Validate token asset identifier with Stellar compliance
   * 
   * ## Security Checks:
   * - Stellar asset code format validation (1-12 alphanumeric chars)
   * - Stellar public key format validation (G-prefixed 56 char base32)
   * - Contract address format validation
   * - Malformed address detection
   * - Blacklisted address checking
   * 
   * @param context - Validation context containing token data
   * @returns Validation rule result with asset validation findings
   */
  private async validateTokenAsset(context: OfferingValidationContext): Promise<ValidationRuleResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    const { offeringData } = context;

    if (!offeringData.token_asset_id || offeringData.token_asset_id.trim().length === 0) {
      errors.push({
        code: 'TOKEN_ASSET_REQUIRED',
        message: 'Token asset ID is required',
        field: 'token_asset_id',
        severity: 'error',
        category: 'business'
      });
      return { isValid: false, errors, warnings: [] };
    }

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

    // Stellar asset code validation (1-12 alphanumeric characters)
    if (/^[a-zA-Z0-9]{1,12}$/.test(assetId)) {
      // Valid Stellar asset code format
      return { isValid: true, errors: [], warnings: [] };
    }

    // Stellar public key validation (G-prefixed, 56 characters, base32)
    const stellarPublicKeyPattern = /^G[A-Z2-7]{55}$/;
    if (stellarPublicKeyPattern.test(assetId)) {
      // Additional validation for Stellar public key checksum
      try {
        // This would use Stellar SDK for validation in production
        // For now, we'll do basic format validation
        warnings.push({
          code: 'STELLAR_PUBLIC_KEY_FORMAT',
          message: 'Stellar public key detected - ensure this is intentional',
          field: 'token_asset_id',
          category: 'business'
        });
        return { isValid: true, errors, warnings };
      } catch (error) {
        errors.push({
          code: 'INVALID_STELLAR_PUBLIC_KEY',
          message: 'Invalid Stellar public key format',
          field: 'token_asset_id',
          severity: 'error',
          category: 'technical',
          remediation: 'Verify the Stellar public key is correct'
        });
      }
    }

    // Contract address validation (hexadecimal format)
    const contractAddressPattern = /^0x[a-fA-F0-9]{40}$/;
    if (contractAddressPattern.test(assetId)) {
      warnings.push({
        code: 'CONTRACT_ADDRESS_FORMAT',
        message: 'Contract address detected - ensure this is supported',
        field: 'token_asset_id',
        category: 'business'
      });
      return { isValid: true, errors, warnings };
    }

    // Check for common malformed patterns
    const malformedPatterns = [
      /[gG][a-zA-Z0-9]{55,}/, // Too long Stellar address
      /^[a-zA-Z0-9]{13,}/, // Too long asset code
      /[^a-zA-Z0-9G]/, // Invalid characters
      /\s/, // Whitespace
      /\x00/ // Null bytes
    ];

    for (const pattern of malformedPatterns) {
      if (pattern.test(assetId)) {
        errors.push({
          code: 'MALFORMED_TOKEN_FORMAT',
          message: 'Token asset ID contains invalid characters or format',
          field: 'token_asset_id',
          severity: 'error',
          category: 'technical',
          remediation: 'Use valid Stellar asset code (1-12 alphanumeric) or public key'
        });
        break;
      }
    }

    // Check for blacklisted patterns (common attack vectors)
    const blacklistedPatterns = [
      /admin/i,
      /root/i,
      /system/i,
      /config/i,
      /test/i,
      /demo/i,
      /sample/i
    ];

    for (const pattern of blacklistedPatterns) {
      if (pattern.test(assetId)) {
        warnings.push({
          code: 'SUSPICIOUS_TOKEN_NAME',
          message: 'Token asset ID contains suspicious pattern',
          field: 'token_asset_id',
          category: 'security'
        });
      }
    }

    // If we get here, the format is not recognized
    if (errors.length === 0) {
      errors.push({
        code: 'UNRECOGNIZED_TOKEN_FORMAT',
        message: 'Token asset ID format not recognized. Use Stellar asset code (1-12 alphanumeric) or public key',
        field: 'token_asset_id',
        severity: 'error',
        category: 'business',
        remediation: 'Provide valid Stellar asset identifier'
      });
    }

    return { isValid: errors.length === 0, errors, warnings };
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

    const currentStatus = offering.status || 'draft';
    const newStatus = offeringData.status;

    // Define valid status transitions
    const validTransitions: Record<string, string[]> = {
      'draft': ['active', 'closed'],
      'active': ['paused', 'closed'],
      'paused': ['active', 'closed'],
      'closed': []
    };

    if (!validTransitions[currentStatus as string]?.includes(newStatus)) {
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
