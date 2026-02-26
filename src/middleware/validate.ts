import { Request, Response, NextFunction, RequestHandler } from 'express';

type PrimitiveType = 'string' | 'number' | 'boolean';

export type FieldSchema = {
  type: PrimitiveType;
  required?: boolean;
  pattern?: RegExp;
  min?: number;
  max?: number;
  oneOf?: Array<string | number | boolean>;
};

export type ObjectSchema = Record<string, FieldSchema>;

export type ValidateOptions = {
  body?: ObjectSchema;
  query?: ObjectSchema;
  params?: ObjectSchema;
};

type ValidationResult = {
  valid: boolean;
  errors: string[];
};

function coerce(value: unknown, type: PrimitiveType): unknown {
  if (value == null) return value;
  if (type === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      return Number(value);
    }
    return value;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
    }
    return value;
  }
  return String(value);
}

function validateObject(input: any, schema: ObjectSchema, pathPrefix: string): ValidationResult {
  const errors: string[] = [];

  for (const key of Object.keys(schema)) {
    const rule = schema[key];
    const value = input?.[key];
    const path = `${pathPrefix}.${key}`;

    if (value == null || value === '') {
      if (rule.required) {
        errors.push(`${path}: required`);
      }
      continue;
    }

    const coerced = coerce(value, rule.type);
    const actualType = typeof coerced;
    if (actualType !== rule.type) {
      errors.push(`${path}: expected ${rule.type}`);
      continue;
    }

    if (rule.type === 'string') {
      const str = coerced as string;
      if (rule.min != null && str.length < rule.min) {
        errors.push(`${path}: length must be >= ${rule.min}`);
      }
      if (rule.max != null && str.length > rule.max) {
        errors.push(`${path}: length must be <= ${rule.max}`);
      }
      if (rule.pattern && !rule.pattern.test(str)) {
        errors.push(`${path}: invalid format`);
      }
      if (rule.oneOf && !rule.oneOf.includes(str)) {
        errors.push(`${path}: must be one of ${rule.oneOf.join(', ')}`);
      }
    }

    if (rule.type === 'number') {
      const num = coerced as number;
      if (Number.isNaN(num)) {
        errors.push(`${path}: expected number`);
      } else {
        if (rule.min != null && num < rule.min) {
          errors.push(`${path}: must be >= ${rule.min}`);
        }
        if (rule.max != null && num > rule.max) {
          errors.push(`${path}: must be <= ${rule.max}`);
        }
        if (rule.oneOf && !rule.oneOf.includes(num)) {
          errors.push(`${path}: must be one of ${rule.oneOf.join(', ')}`);
        }
      }
    }

    if (rule.type === 'boolean') {
      const bool = coerced as boolean;
      if (typeof bool !== 'boolean') {
        errors.push(`${path}: expected boolean`);
      }
      if (rule.oneOf && !rule.oneOf.includes(bool)) {
        errors.push(`${path}: must be one of ${rule.oneOf.join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function makeMiddleware(
  schema: ObjectSchema | undefined,
  pick: (req: Request) => any,
  locationName: 'body' | 'query' | 'params'
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!schema) {
      next();
      return;
    }
    const data = pick(req);
    const result = validateObject(data, schema, locationName);
    if (!result.valid) {
      res.status(400).json({ error: 'ValidationError', details: result.errors });
      return;
    }
    next();
  };
}

export function validateBody(schema: ObjectSchema): RequestHandler {
  return makeMiddleware(schema, (req) => req.body, 'body');
}

export function validateQuery(schema: ObjectSchema): RequestHandler {
  return makeMiddleware(schema, (req) => req.query, 'query');
}

export function validateParams(schema: ObjectSchema): RequestHandler {
  return makeMiddleware(schema, (req) => req.params, 'params');
}

export function validate(arg: ObjectSchema | ValidateOptions): RequestHandler[] | RequestHandler {
  if ('body' in (arg as any) || 'query' in (arg as any) || 'params' in (arg as any)) {
    const opts = arg as ValidateOptions;
    const parts: RequestHandler[] = [];
    if (opts.params) parts.push(validateParams(opts.params));
    if (opts.query) parts.push(validateQuery(opts.query));
    if (opts.body) parts.push(validateBody(opts.body));
    return parts;
  }
  return validateBody(arg as ObjectSchema);
}

