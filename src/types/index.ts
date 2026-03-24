/**
 * @title Core Types for Offering Validation Matrix
 * @dev Production-grade type definitions for Stellar RevenueShare validation system
 */

/**
 * @dev User entity with role-based access control
 */
export interface User {
  /** Unique identifier for the user */
  id: string;
  /** User email address */
  email: string;
  /** User role determining access levels */
  role: 'startup' | 'investor' | 'admin' | 'verifier';
  /** Account creation timestamp */
  created_at: Date;
  /** Last update timestamp */
  updated_at: Date;
}

/**
 * @dev Offering entity with validation metadata
 */
export interface Offering {
  /** Unique offering identifier */
  id: string;
  /** Stellar contract address */
  contract_address?: string;
  /** Issuer user identifier */
  issuer_user_id?: string;
  /** Alternative issuer ID field */
  issuer_id?: string;
  /** Offering name */
  name?: string;
  /** Token symbol */
  symbol?: string;
  /** Current offering status */
  status?: OfferingStatus;
  /** Total amount raised (as string for precision) */
  total_raised?: string;
  /** Creation timestamp */
  created_at?: Date;
  /** Last update timestamp */
  updated_at?: Date;
  /** Additional metadata */
  [key: string]: unknown;
}

/**
 * @dev Valid offering statuses with type safety
 */
export type OfferingStatus = 
  | 'draft' 
  | 'open' 
  | 'closed' 
  | 'paused' 
  | 'cancelled' 
  | 'active' 
  | 'completed';

/**
 * @dev Input types for offering operations
 */
export type CreateOfferingInput = Record<string, unknown>;
export type UpdateOfferingInput = Record<string, unknown>;

/**
 * @dev Validation context for offering operations
 */
export interface OfferingValidationContext {
  /** Authenticated user context */
  user: User;
  /** Existing offering for updates */
  offering?: Offering;
  /** User's existing offerings for duplicate checks */
  existingOfferings?: Offering[];
  /** Raw request payload */
  requestPayload: Record<string, any>;
  /** Validation operation type */
  operation: 'create' | 'update' | 'delete' | 'status_change';
  /** Client IP address for security logging */
  ipAddress?: string;
  /** User agent for security analysis */
  userAgent?: string;
  /** Offering-specific data for validation */
  offeringData: {
    name?: string;
    description?: string;
    revenue_share_bps?: number;
    token_asset_id?: string;
    status?: string;
  };
}

/**
 * @dev Validation result with comprehensive metadata
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
 * @dev Detailed validation error information
 */
export interface ValidationError {
  /** Machine-readable error code */
  code: string;
  /** Human-readable error message */
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
 * @dev Validation warning for non-critical issues
 */
export interface ValidationWarning {
  /** Machine-readable warning code */
  code: string;
  /** Human-readable warning message */
  message: string;
  /** Field that generated warning */
  field?: string;
  /** Warning category */
  category: 'performance' | 'business' | 'security';
}

/**
 * @dev Validation execution metadata
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
 * @dev Validation rule definition
 */
export interface ValidationRule {
  /** Unique rule identifier */
  name: string;
  /** Human-readable rule description */
  description: string;
  /** Rule category for organization */
  category: 'security' | 'business' | 'technical' | 'compliance';
  /** Execution priority (lower = higher priority) */
  priority: number;
  /** Whether rule failure is critical */
  isRequired: boolean;
  /** Validation function implementation */
  validate: (context: OfferingValidationContext) => Promise<ValidationRuleResult>;
}

/**
 * @dev Individual rule validation result
 */
export interface ValidationRuleResult {
  /** Rule-specific validation status */
  isValid: boolean;
  /** Rule-specific errors */
  errors: ValidationError[];
  /** Rule-specific warnings */
  warnings: ValidationWarning[];
}

/**
 * @dev Repository interfaces for dependency injection
 */
export interface OfferingRepository {
  /** Find offering by ID */
  findById(id: string): Promise<Offering | null>;
  /** Find offering by contract address */
  findByContractAddress(contractAddress: string): Promise<Offering | null>;
  /** List all offerings */
  listAll(): Promise<Offering[]>;
  /** Create new offering */
  create(offering: CreateOfferingInput): Promise<Offering>;
  /** Update existing offering */
  update(id: string, partial: UpdateOfferingInput): Promise<Offering | null>;
  /** Update offering status */
  updateStatus(id: string, status: OfferingStatus): Promise<Offering | null>;
  /** Check ownership */
  isOwner(offeringId: string, issuerId: string): Promise<boolean>;
}

/**
 * @dev Investment repository interface
 */
export interface InvestmentRepository {
  /** Get investments by offering */
  findByOffering(offeringId: string): Promise<any[]>;
  /** Get aggregate statistics */
  getAggregateStats(offeringId: string): Promise<{
    totalInvested: string;
    investorCount: number;
  }>;
}

/**
 * @dev Express request with user authentication
 */
export interface AuthenticatedRequest extends Request {
  /** Authenticated user information */
  user?: User;
}

/**
 * @dev Validation configuration options
 */
export interface ValidationConfig {
  /** Maximum payload size in bytes */
  maxPayloadSize?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Custom validation rules */
  customRules?: ValidationRule[];
}
