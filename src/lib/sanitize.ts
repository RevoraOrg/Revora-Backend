/**
 * Minimal input-sanitization helpers for request body string fields.
 *
 * What gets sanitized (recommended for route authors to apply on inputs):
 * - Names/titles/labels: normalize, strip HTML, trim, collapse whitespace, limit length (100).
 * - Descriptions/notes/memos: normalize, strip HTML, keep newlines, collapse spaces, limit length (1000).
 * - Emails/usernames/IDs: normalize, strip HTML, trim, limit length (254 for emails, 100 for IDs).
 * - Free-text arrays (e.g., tags[]): sanitize each element like names/titles unless domain-specific rules apply.
 *
 * How to use (example in handlers after validation):
 *   const clean = sanitizeFields(req.body, {
 *     'title': presets.title(),
 *     'description': presets.description(),
 *     'email': presets.email(),
 *     'tags': presets.stringArray({ maxLength: 50 })
 *   });
 *
 * This module performs conservative plain-text sanitization:
 * - Unicode normalization (NFKC)
 * - Remove NULL bytes and most control chars (keeps \n, \r, \t)
 * - Strip all HTML tags
 * - Collapse whitespace and trim
 * - Enforce maximum length
 *
 * No external dependencies are used and HTML is not allowed in stored fields.
 */

export interface StringSanitizeOptions {
  maxLength?: number;
  keepNewlines?: boolean;
}

/**
 * Sanitize a single string into safe plain text.
 */
export function sanitizeString(input: unknown, opts: StringSanitizeOptions = {}): string {
  const maxLength = Math.max(0, opts.maxLength ?? 500);
  const keepNewlines = opts.keepNewlines ?? false;

  let s = typeof input === 'string' ? input : String(input ?? '');

  try {
    s = s.normalize('NFKC');
  } catch {
    // ignore normalization errors
  }

  // Remove NULL bytes and control characters except \n, \r, \t
  s = s.replace(/\0/g, '');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip HTML tags
  s = s.replace(/<[^>]*>/g, '');

  // Collapse whitespace
  if (keepNewlines) {
    // Preserve newlines but normalize other spacing
    s = s.replace(/[ \t]+/g, ' ');
    // Normalize multiple blank lines
    s = s.replace(/\n{3,}/g, '\n\n');
  } else {
    s = s.replace(/\s+/g, ' ');
  }

  s = s.trim();

  if (s.length > maxLength) {
    s = s.slice(0, maxLength);
  }

  return s;
}

/**
 * Sanitize all provided fields in a plain object. Nested paths can be
 * provided via dot-notation (e.g., "profile.name"). If a target field
 * is an array of strings, each element is sanitized. Non-string values
 * are stringified and sanitized by default.
 */
export function sanitizeFields<T extends Record<string, any>>(
  payload: T,
  spec: Record<string, StringSanitizeOptions | undefined>
): T {
  const clone: any = Array.isArray(payload) ? [...payload] : { ...payload };

  for (const [path, options] of Object.entries(spec)) {
    applyToPath(clone, path, (value) => sanitizeValue(value, options));
  }

  return clone;
}

function sanitizeValue(value: unknown, options?: StringSanitizeOptions): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeString(v, options));
  }
  return sanitizeString(value, options);
}

function applyToPath(obj: any, path: string, transform: (v: unknown) => unknown) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[k];
  }
  if (cur == null || typeof cur !== 'object') return;
  const last = keys[keys.length - 1];
  if (last in cur) {
    cur[last] = transform(cur[last]);
  }
}

/**
 * Useful presets for common field types.
 */
export const presets = {
  title: (overrides: StringSanitizeOptions = {}) =>
    ({ maxLength: 100, keepNewlines: false, ...overrides } as StringSanitizeOptions),
  description: (overrides: StringSanitizeOptions = {}) =>
    ({ maxLength: 1000, keepNewlines: true, ...overrides } as StringSanitizeOptions),
  email: (overrides: StringSanitizeOptions = {}) =>
    ({ maxLength: 254, keepNewlines: false, ...overrides } as StringSanitizeOptions),
  id: (overrides: StringSanitizeOptions = {}) =>
    ({ maxLength: 100, keepNewlines: false, ...overrides } as StringSanitizeOptions),
  stringArray: (overrides: StringSanitizeOptions = {}) =>
    ({ maxLength: 100, keepNewlines: false, ...overrides } as StringSanitizeOptions),
};

export default {
  sanitizeString,
  sanitizeFields,
  presets,
};

