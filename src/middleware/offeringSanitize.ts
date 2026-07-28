import { Request, Response, NextFunction } from 'express';
import { sanitizeObject } from '../lib/sanitize';

/**
 * Middleware to sanitize offering-related fields in the request body.
 * Applies XSS and SSRF protection to HTML-like fields (description)
 * and strips HTML from plain text fields (name, symbol, title).
 */
export const offeringSanitizeMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object') {
    // Sanitize common offering fields if present
    req.body = sanitizeObject(req.body, {
      name: true,        // strips all HTML
      symbol: true,      // strips all HTML
      title: true,       // strips all HTML
      description: {     // allows safe HTML subset
        safeHTML: true,
        allowNewlines: true,
        maxLength: 5000,
      },
    });
  }
  next();
};
