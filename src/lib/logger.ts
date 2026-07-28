/**
 * Structured Logging Service
 * 
 * Production-grade logging with structured output, log levels, and context propagation.
 * Designed for cloud-native environments with JSON output for log aggregation systems.
 * 
 * Security Assumptions:
 * - PII and sensitive data must be explicitly redacted before logging
 * - Log output should not contain credentials, tokens, or private keys
 * - Error stack traces may contain sensitive paths in production
 * 
 * @module lib/logger
 */

/**
 * Standard log levels following RFC 5424 severity levels
 */
export enum LogLevel {
  /** System is unusable */
  EMERGENCY = 0,
  /** Action must be taken immediately */
  ALERT = 1,
  /** Critical conditions */
  CRITICAL = 2,
  /** Error conditions */
  ERROR = 3,
  /** Warning conditions */
  WARN = 4,
  /** Normal but significant condition */
  INFO = 5,
  /** Informational messages */
  DEBUG = 6,
  /** Debug-level messages */
  TRACE = 7,
}

/**
 * Log level names for human-readable output
 */
const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.EMERGENCY]: 'EMERGENCY',
  [LogLevel.ALERT]: 'ALERT',
  [LogLevel.CRITICAL]: 'CRITICAL',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE',
};

/**
 * Structured log entry
 */
export interface LogEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Log level */
  level: string;
  /** Log message */
  message: string;
  /** Request ID for correlation */
  requestId?: string;
  /** User ID for audit trail */
  userId?: string;
  /** Additional context data */
  context?: Record<string, unknown>;
  /** Error details if applicable */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  /** Allow any additional properties from context */
  [key: string]: unknown;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum log level to output */
  level: LogLevel;
  /** Enable pretty-printing for development */
  pretty: boolean;
  /** Include stack traces in error logs */
  includeStackTrace: boolean;
  /** Service name for log identification */
  serviceName: string;
}

/**
 * Fields to redact from logs (case-insensitive)
 */
const SENSITIVE_FIELDS = [
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'session',
  'private_key',
  'privatekey',
  'credit_card',
  'creditcard',
  'ssn',
  'social_security',
];

/**
 * Logger - Structured logging service with context propagation
 * 
 * Provides structured JSON logging with automatic PII redaction and
 * context propagation for distributed tracing.
 * 
 * Usage:
 * ```typescript
 * const logger = new Logger({ level: LogLevel.INFO });
 * logger.info('User logged in', { userId: '123', ip: '192.168.1.1' });
 * logger.error('Database connection failed', { error: dbError });
 * ```
 */
export class Logger {
  private config: LoggerConfig;
  private context: Record<string, unknown> = {};

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: config.level ?? this.getDefaultLogLevel(),
      pretty: config.pretty ?? process.env.NODE_ENV !== 'production',
      includeStackTrace: config.includeStackTrace ?? process.env.NODE_ENV !== 'production',
      serviceName: config.serviceName ?? 'revora-backend',
    };
  }

  /**
   * Get default log level from environment
   */
  private getDefaultLogLevel(): LogLevel {
    const envLevel = process.env.LOG_LEVEL?.toUpperCase();
    switch (envLevel) {
      case 'EMERGENCY': return LogLevel.EMERGENCY;
      case 'ALERT': return LogLevel.ALERT;
      case 'CRITICAL': return LogLevel.CRITICAL;
      case 'ERROR': return LogLevel.ERROR;
      case 'WARN': return LogLevel.WARN;
      case 'INFO': return LogLevel.INFO;
      case 'DEBUG': return LogLevel.DEBUG;
      case 'TRACE': return LogLevel.TRACE;
      default: return process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
    }
  }

  /**
   * Set persistent context for all subsequent logs
   * @param context Context data to merge
   */
  setContext(context: Record<string, unknown>): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear persistent context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Create a child logger with additional context
   * @param context Additional context for child logger
   * @returns New logger instance with merged context
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger(this.config);
    child.context = { ...this.context, ...context };
    return child;
  }

  /**
   * Redact sensitive fields from object
   * @param obj Object to redact
   * @returns Redacted object
   */
  private redactSensitive(obj: unknown, seen = new WeakSet<object>()): unknown {
    if (obj === null || obj === undefined) return obj;
    
    if (typeof obj !== 'object') return obj;

    if (obj instanceof Error) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactSensitive(item, seen));
    }

    if (seen.has(obj)) {
      return '[Circular]';
    }
    seen.add(obj);

    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_FIELDS.some((field) => lowerKey.includes(field));
      
      if (isSensitive) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        redacted[key] = this.redactSensitive(value, seen);
      } else {
        redacted[key] = value;
      }
    }
    
    return redacted;
  }

  /**
   * Format error for logging
   * @param error Error object
   * @returns Formatted error object
   */
  private formatError(error: unknown): LogEntry['error'] {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: this.config.includeStackTrace ? error.stack : undefined,
      };
    }
    
    return {
      name: 'UnknownError',
      message: String(error),
    };
  }

  /**
   * Write log entry
   * @param level Log level
   * @param message Log message
   * @param context Additional context
   */
  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (level > this.config.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LOG_LEVEL_NAMES[level],
      message,
      ...this.context,
    };

    if (context) {
      const redacted = this.redactSensitive(context) as Record<string, unknown>;
      
      // Extract special fields
      if (redacted.requestId) {
        entry.requestId = String(redacted.requestId);
        delete redacted.requestId;
      }
      if (redacted.userId) {
        entry.userId = String(redacted.userId);
        delete redacted.userId;
      }
      if (redacted.error) {
        entry.error = this.formatError(redacted.error);
        delete redacted.error;
      }
      
      // Add remaining context
      if (Object.keys(redacted).length > 0) {
        entry.context = redacted;
      }
    }

    const output = this.config.pretty ? this.prettyFormat(entry) : JSON.stringify(entry);
    
    // Route to appropriate console method
    if (level <= LogLevel.ERROR) {
      console.error(output);
    } else if (level === LogLevel.WARN) {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  /**
   * Pretty-print log entry for development
   * @param entry Log entry
   * @returns Formatted string
   */
  private prettyFormat(entry: LogEntry): string {
    const parts = [
      entry.timestamp,
      `[${entry.level}]`,
      entry.message,
    ];

    if (entry.requestId) {
      parts.push(`(req: ${entry.requestId})`);
    }

    if (entry.userId) {
      parts.push(`(user: ${entry.userId})`);
    }

    if (entry.context) {
      parts.push(JSON.stringify(entry.context));
    }

    if (entry.error) {
      parts.push(`\nError: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push(`\n${entry.error.stack}`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Log emergency message
   */
  emergency(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.EMERGENCY, message, context);
  }

  /**
   * Log alert message
   */
  alert(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ALERT, message, context);
  }

  /**
   * Log critical message
   */
  critical(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.CRITICAL, message, context);
  }

  /**
   * Log error message
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  /**
   * Log info message
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * Log trace message
   */
  trace(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.TRACE, message, context);
  }
}

/**
 * Global logger instance
 * Singleton pattern for application-wide logging
 */
export const globalLogger = new Logger();
export const logger = globalLogger;
