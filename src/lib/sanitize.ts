import { globalLogger } from './logger';

export type SanitizeOptions = {
  maxLength?: number;
  stripHTML?: boolean;
  safeHTML?: boolean;
  trim?: boolean;
  collapseWhitespace?: boolean;
  normalize?: boolean;
  allowNewlines?: boolean;
};

const DEFAULTS: Required<SanitizeOptions> = {
  maxLength: 1000,
  stripHTML: true,
  safeHTML: false,
  trim: true,
  collapseWhitespace: true,
  normalize: true,
  allowNewlines: false,
};

const SCRIPT_TAG_RE = /<script[\s\S]*?>[\s\S]*?<\/script>/gi;
const STYLE_TAG_RE = /<style[\s\S]*?>[\s\S]*?<\/style>/gi;
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const ANY_TAG_RE = /<\/?[^>]+>/g;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// SSRF Protection: Block private IP ranges and localhost
const PRIVATE_IP_PREFIX_RE = /^(?:127\.|10\.|172\.(?:1[6-9]|2[0-9]|3[0-1])\.|192\.168\.|0\.|169\.254\.|fe80:)/i;
const PRIVATE_HOSTS = new Set(['localhost', '::1', '127.0.0.1']);

/**
 * Validates if a URL is safe from SSRF vectors.
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    
    const hostname = parsed.hostname.toLowerCase();
    
    // Block literal private IPs and localhost
    if (PRIVATE_IP_PREFIX_RE.test(hostname) || PRIVATE_HOSTS.has(hostname)) {
      return false;
    }
    
    // Additional check for IPv6 brackets
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      const inner = hostname.slice(1, -1);
      if (PRIVATE_HOSTS.has(inner) || PRIVATE_IP_PREFIX_RE.test(inner)) {
        return false;
      }
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize HTML to allow only a safe subset of tags and attributes.
 * Prevents XSS and SSRF.
 */
function sanitizeHTML(input: string): string {
  let s = input;
  
  // Preliminary cleanup
  s = s.replace(HTML_COMMENT_RE, '');
  s = s.replace(SCRIPT_TAG_RE, '');
  s = s.replace(STYLE_TAG_RE, '');
  
  const allowedTags = ['b', 'i', 'em', 'strong', 'p', 'br', 'ul', 'ol', 'li', 'a', 'img', 'h1', 'h2', 'h3'];
  
  // Use a regex to process tags. This is a whitelist-based approach.
  s = s.replace(/<\/?([a-z0-9]+)\b([^>]*)>/gi, (match, tagName, attributes) => {
    const lowerTag = tagName.toLowerCase();
    if (!allowedTags.includes(lowerTag)) {
      globalLogger.warn(`Stripping disallowed HTML tag: ${lowerTag}`, { tag: match });
      return '';
    }
    
    if (match.startsWith('</')) {
      return `</${lowerTag}>`;
    }
    
    // Process attributes for allowed tags
    let safeAttrs = '';
    
    if (lowerTag === 'a') {
      const hrefMatch = attributes.match(/\bhref=(?:"([^"]*)"|'([^']*)'|([^>\s]+))/i);
      const url = hrefMatch?.[1] || hrefMatch?.[2] || hrefMatch?.[3];
      if (url && isSafeUrl(url)) {
        safeAttrs = ` href="${url}" rel="noopener noreferrer" target="_blank"`;
      } else if (url) {
        globalLogger.warn('Stripping unsafe URL in anchor tag', { url });
      }
    } else if (lowerTag === 'img') {
      const srcMatch = attributes.match(/\bsrc=(?:"([^"]*)"|'([^']*)'|([^>\s]+))/i);
      const altMatch = attributes.match(/\balt=(?:"([^"]*)"|'([^']*)'|([^>\s]+))/i);
      const url = srcMatch?.[1] || srcMatch?.[2] || srcMatch?.[3];
      const alt = altMatch?.[1] || altMatch?.[2] || altMatch?.[3] || '';
      
      if (url && isSafeUrl(url)) {
        safeAttrs = ` src="${url}" alt="${alt.replace(/"/g, '&quot;')}"`;
      } else {
        if (url) globalLogger.warn('Stripping unsafe URL in image tag', { url });
        return ''; // Don't allow images without safe src
      }
    }
    
    return `<${lowerTag}${safeAttrs}>`;
  });
  
  return s;
}

export function sanitizeString(input: unknown, opts?: SanitizeOptions): string {
  const o = { ...DEFAULTS, ...(opts ?? {}) };
  if (input === null || input === undefined) return '';
  let s = String(input);
  
  if (o.normalize && 'normalize' in String.prototype) {
    try {
      s = s.normalize('NFC');
    } catch {
      /* noop */
    }
  }
  
  if (o.safeHTML) {
    s = sanitizeHTML(s);
  } else if (o.stripHTML) {
    s = s.replace(HTML_COMMENT_RE, '');
    s = s.replace(SCRIPT_TAG_RE, '');
    s = s.replace(STYLE_TAG_RE, '');
    s = s.replace(ANY_TAG_RE, '');
  }
  
  s = s.replace(CONTROL_CHARS_RE, '');
  if (o.trim) s = s.trim();
  
  if (o.collapseWhitespace) {
    if (o.allowNewlines) {
      s = s
        .split('\n')
        .map((line) => line.replace(/[ \t\f\v\r]+/g, ' ').trim())
        .join('\n');
      s = s.replace(/\n{3,}/g, '\n\n');
    } else {
      s = s.replace(/\s+/g, ' ');
    }
    s = s.trim();
  }
  
  if (s.length > o.maxLength) s = s.slice(0, o.maxLength);
  return s;
}

export type FieldRule = SanitizeOptions & {
  required?: boolean;
  default?: string;
  type?: 'string' | 'string[]';
};

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

export function sanitizeObject<T extends Record<string, unknown>>(
  input: T,
  rules: Record<string, FieldRule | true>
): T {
  const out: any = { ...input };
  for (const [path, rule] of Object.entries(rules)) {
    const r: FieldRule =
      rule === true ? { type: 'string' } : { type: 'string', ...rule };
    const val = getByPath(out, path);
    if (val === undefined || val === null) {
      if (r.required && r.default !== undefined) {
        setByPath(out, path, sanitizeString(r.default, r));
      }
      continue;
    }
    if (r.type === 'string[]' && Array.isArray(val)) {
      const sanitized = val.map((v) =>
        typeof v === 'string' ? sanitizeString(v, r) : v
      );
      setByPath(out, path, sanitized);
      continue;
    }
    if (typeof val === 'string') {
      setByPath(out, path, sanitizeString(val, r));
    }
  }
  return out;
}

export const defaultStringRules: SanitizeOptions = {
  maxLength: DEFAULTS.maxLength,
  stripHTML: true,
  trim: true,
  collapseWhitespace: true,
  normalize: true,
  allowNewlines: false,
};
