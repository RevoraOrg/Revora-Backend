export type SanitizeOptions = {
  maxLength?: number;
  stripHTML?: boolean;
  trim?: boolean;
  collapseWhitespace?: boolean;
  normalize?: boolean;
  allowNewlines?: boolean;
};

const DEFAULTS: Required<SanitizeOptions> = {
  maxLength: 1000,
  stripHTML: true,
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
  if (o.stripHTML) {
    s = s.replace(HTML_COMMENT_RE, '');
    s = s.replace(SCRIPT_TAG_RE, '');
    s = s.replace(STYLE_TAG_RE, '');
    s = s.replace(ANY_TAG_RE, '');
  }
  s = s.replace(CONTROL_CHARS_RE, '');
  if (o.trim) s = s.trim();
  if (o.collapseWhitespace) {
    if (o.allowNewlines) {
      s = s.replace(/[ \t\f\v\r]+/g, ' ');
      s = s.replace(/ *\n+ */g, '\n');
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
