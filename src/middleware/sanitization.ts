import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * @dev Deeply sanitizes an input value by:
 * 1. Trimming strings
 * 2. Removing null bytes (\0)
 * 3. Removing control characters
 * 4. Normalizing whitespace (optional, but good for consistency)
 * 5. Stripping basic HTML tags to prevent XSS
 */
export function sanitizeValue(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return input
      .replace(/\0/g, '') // Remove null bytes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
      .replace(/<[^>]*>/g, '') // Remove all HTML tags
      .trim(); // Trim whitespace
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeValue);
  }

  if (typeof input === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      sanitized[key] = sanitizeValue(value);
    }
    return sanitized;
  }

  return input;
}

/**
 * @dev Middleware that sanitizes request body, query, and params.
 * Security assumption: No sensitive fields require raw HTML or control characters.
 * Trimming is applied to all string values to ensure deterministic behavior.
 */
export const createSanitizationMiddleware = (): RequestHandler => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeValue(req.body);
    }
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeValue(req.query as Record<string, unknown>);
    }
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeValue(req.params);
    }
    next();
  };
};
