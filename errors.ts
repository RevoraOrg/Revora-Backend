/**
 * Custom error class for handling concurrency conflicts.
 * Aligns with the project's security standards by providing
 * descriptive but non-sensitive error information.
 */
export class ConcurrencyError extends Error {
  public readonly statusCode: number = 409;
  public readonly errorCode: string = 'CONCURRENCY_CONFLICT';

  constructor(message: string = 'The resource has been modified by another process. Please refresh and try again.') {
    super(message);
    this.name = 'ConcurrencyError';
    Object.setPrototypeOf(this, ConcurrencyError.prototype);
  }

  /**
   * Formats the error for client-facing JSON responses.
   * Ensures no raw stack traces or DB strings are leaked.
   */
  public toJSON() {
    return {
      error: 'Conflict',
      message: this.message,
      code: this.errorCode,
    };
  }
}

export type AppError = ConcurrencyError;