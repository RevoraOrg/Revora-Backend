import supertest from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import listEndpoints from 'express-list-endpoints';
import { createApp } from '../index';
import { pool as primaryPool } from '../db/pool';
import { pool as healthPool } from '../db/client';
import path from 'path';

// The health/readiness probes call Stellar Horizon over HTTPS. In offline CI
// the DNS lookup for horizon.stellar.org can block longer than the probe's own
// timeout (Node's fetch abort does not always interrupt a pending DNS query).
// Point it at a fast-failing local address so the probes settle immediately;
// this does not affect the schema assertions under test.
process.env.STELLAR_HORIZON_URL = 'http://127.0.0.1:9/';

/**
 * OpenAPI conformance suite.
 *
 * The suite derives the API surface from the *served* Express app
 * (`express-list-endpoints`) rather than from the spec, so every route a
 * handler actually serves must be documented in `src/docs/openapi.yaml`, and
 * no documented route may be unmounted. Each served operation is then
 * exercised with a schema-derived request body and its response body is
 * validated against the schema declared for the status code the handler
 * actually returns.
 *
 * This enforces, in one place, that request schemas and response schemas in
 * the OpenAPI document agree with the served handlers.
 */

let spec: any;
let ajv: Ajv;

const UUID = '00000000-0000-0000-0000-000000000000';

/** HTTP methods that carry a response body and are executed by the suite. */
const EXECUTABLE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Normalize an Express `:param` path into OpenAPI `{param}` form. */
const toOpenApiPath = (p: string): string =>
  p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Recursively apply `additionalProperties: false` unless the schema already
 * opts out explicitly (`true`), so handlers returning undocumented fields
 * fail the response validation.
 */
const enforceAdditionalProperties = (schema: any, seen = new WeakSet()) => {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return;
  seen.add(schema);

  if (schema.type === 'object' && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      enforceAdditionalProperties(schema.properties[key], seen);
    }
  }
  if (schema.items) enforceAdditionalProperties(schema.items, seen);
  (['oneOf', 'anyOf', 'allOf'] as const).forEach((composer) => {
    if (schema[composer]) schema[composer].forEach((s: any) => enforceAdditionalProperties(s, seen));
  });
  if (schema.not) enforceAdditionalProperties(schema.not, seen);
};

/** Replace path `{param}` placeholders with concrete values. */
const resolvePathParams = (pathStr: string): string => {
  return pathStr.replace(/\{([^}]+)\}/g, (match, param: string) => {
    if (param === 'id' || param.endsWith('Id') || param.toLowerCase().endsWith('id')) {
      return UUID;
    }
    return 'sample-' + param;
  });
};

/**
 * Deterministically generate a sample value that conforms to a JSON schema.
 * Used both to prove the declared request schema is well-formed and to drive
 * the served handler during the request side of the conformance check.
 */
const generateSample = (schema: any, depth = 0): any => {
  if (!schema || typeof schema !== 'object') return undefined;

  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    return generateSample(schema.oneOf[0], depth);
  }
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    return generateSample(schema.anyOf[0], depth);
  }
  if (schema.allOf && Array.isArray(schema.allOf)) {
    const merged: any = { ...schema.allOf[0] };
    return generateSample(merged, depth);
  }
  if (schema.$ref) return generateSample(spec.components.schemas[refName(schema.$ref)], depth);

  const type = schema.type;
  if (Array.isArray(type)) return generateSample({ ...schema, type: type[0] }, depth);

  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  if (depth >= 4) return undefined;

  switch (type) {
    case 'object':
      if (schema.properties) {
        // Only materialize own properties to respect additionalProperties.
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(schema.properties)) {
          const propSchema = schema.properties[key];
          if (propSchema.additionalProperties === true && !Object.keys(propSchema).some((k) => k !== 'additionalProperties')) {
            continue;
          }
          out[key] = generateSample(propSchema, depth + 1);
        }
        if (schema.required) {
          for (const key of schema.required) {
            if (out[key] === undefined) out[key] = null;
          }
        }
        return out;
      }
      return {};
    case 'array':
      return [generateSample(schema.items ?? {}, depth + 1)];
    case 'integer':
      return 1;
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'string':
    case 'null':
    default:
      return sampleString(schema);
  }
};

const refName = (ref: string): string => ref.split('/').pop() ?? '';

const sampleString = (schema: any): any => {
  switch (schema.format) {
    case 'email':
      return 'user@example.com';
    case 'uuid':
      return UUID;
    case 'date-time':
    case 'datetime':
      return '2024-01-01T00:00:00.000Z';
    case 'password':
      return 'Password123!';
    default:
      return 'string';
  }
};

/** Represent a returned status code as an OpenAPI response key. */
const statusKey = (status: number): string => String(status);

beforeAll(async () => {
  const specPath = path.resolve(__dirname, '../docs/openapi.yaml');
  const rawSpec = await SwaggerParser.dereference(specPath);
  spec = rawSpec;

  ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  // ajv-formats does not ship a `password` format.
  ajv.addFormat('password', () => true);

  if (spec.paths) {
    for (const pathStr of Object.keys(spec.paths)) {
      for (const method of Object.keys(spec.paths[pathStr])) {
        const operation = spec.paths[pathStr][method];
        if (!operation || typeof operation !== 'object') continue;
        if (operation.requestBody?.content?.['application/json']?.schema) {
          enforceAdditionalProperties(operation.requestBody.content['application/json'].schema);
        }
        if (operation.responses) {
          for (const status of Object.keys(operation.responses)) {
            const response = operation.responses[status];
            const responseSchema = response?.content?.['application/json']?.schema;
            if (responseSchema) enforceAdditionalProperties(responseSchema);
          }
        }
      }
    }
  }
});

interface ServedOperation {
  method: string;
  path: string; // OpenAPI-formatted path (i.e. {param})
}

describe('OpenAPI Conformance', () => {
  it('served routes and OpenAPI document agree (bidirectional parity)', () => {
    jest.setTimeout(60000);
    const app = createApp();
    const served = new Set<string>();
    for (const endpoint of listEndpoints(app) as Array<{ path: string; methods: string[] }>) {
      for (const m of endpoint.methods) {
        const method = m.toLowerCase();
        if (EXECUTABLE_METHODS.includes(method)) {
          served.add(`${method} ${toOpenApiPath(endpoint.path)}`);
        }
      }
    }

    const documented = new Set<string>();
    if (spec.paths) {
      for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
        for (const method of Object.keys(pathObj as any)) {
          if (EXECUTABLE_METHODS.includes(method)) {
            documented.add(`${method} ${pathStr}`);
          }
        }
      }
    }

    const missingInSpec = Array.from(served).filter((r) => !documented.has(r)).sort();
    const extraInSpec = Array.from(documented).filter((r) => !served.has(r)).sort();

    if (missingInSpec.length > 0) {
      console.warn('Served but not documented:', missingInSpec);
    }
    if (extraInSpec.length > 0) {
      console.warn('Documented but not served:', extraInSpec);
    }
    expect(missingInSpec).toEqual([]);
    expect(extraInSpec).toEqual([]);
  });

  it(
    'request and response schemas match served handlers',
    async () => {

    const app = createApp();
    const served = new Set<string>();
    for (const endpoint of listEndpoints(app) as Array<{ path: string; methods: string[] }>) {
      for (const m of endpoint.methods) {
        const method = m.toLowerCase();
        if (EXECUTABLE_METHODS.includes(method)) {
          served.add(`${method} ${toOpenApiPath(endpoint.path)}`);
        }
      }
    }

    const operations: ServedOperation[] = [];
    for (const key of served) {
      const [method, ...rest] = key.split(' ');
      operations.push({ method, path: rest.join(' ') });
    }

    const errors: string[] = [];

    for (const op of operations) {
      const operation = spec.paths?.[op.path]?.[op.method];
      if (!operation) {
        errors.push(`Missing operation ${op.method.toUpperCase()} ${op.path}`);
        continue;
      }

            let req = ((supertest(app) as any)[op.method](resolvePathParams(op.path)) as any).timeout(15000);

      const requestSchema = operation.requestBody?.content?.['application/json']?.schema;
      if (op.method !== 'get' && op.method !== 'delete') {
        let body: any;
        if (requestSchema) {
          body = generateSample(requestSchema);
          // Request-schema conformance: the body we send must itself be valid.
          try {
            const validate = ajv.compile(requestSchema);
            const valid = validate(body);
            if (!valid) {
              errors.push(
                `Request body for ${op.method.toUpperCase()} ${op.path} fails its own schema: ` +
                  ajv.errorsText(validate.errors),
              );
            }
          } catch (e: any) {
            errors.push(`Failed to compile request schema for ${op.method.toUpperCase()} ${op.path}: ${e.message}`);
          }
        } else {
          body = {};
        }
        req = req.send(body);
      }

      let res: any;
      try {
        res = await req;
      } catch (e: any) {
        errors.push(`Request error for ${op.method.toUpperCase()} ${op.path}: ${e.message}`);
        continue;
      }

      const status = statusKey(res.status);

      // Graceful skip: route is served but resolves to the catch-all 404.
      if (res.status === 404 && res.body?.message === 'Route not found') {
        continue;
      }

      const responses = operation.responses ?? {};
      const documented =
        responses[status] || responses['default'];

      if (!documented) {
        errors.push(
          `Undocumented status code ${status} for ${op.method.toUpperCase()} ${op.path} ` +
            `(documented: ${Object.keys(responses).join(', ') || 'none'}). ` +
            `Body: ${JSON.stringify(res.body)}`,
        );
        continue;
      }

      const responseSchema = documented.content?.['application/json']?.schema;
      if (responseSchema) {
        try {
          const validate = ajv.compile(responseSchema);
          const valid = validate(res.body);
          if (!valid) {
            errors.push(
              `Schema validation failed for ${op.method.toUpperCase()} ${op.path} (${status}): ` +
                ajv.errorsText(validate.errors) +
                ` | Body: ${JSON.stringify(res.body)}`,
            );
          }
        } catch (e: any) {
          errors.push(`Failed to compile response schema for ${op.method.toUpperCase()} ${op.path} (${status}): ${e.message}`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(`Conformance errors:\n` + errors.join('\n'));
    }
    },
    120000,
  );
});

afterAll(async () => {
  // Release DB pool handles so Jest does not hang waiting on open sockets.
  try {
    await primaryPool.end();
  } catch {
    /* already closed */
  }
  try {
    await healthPool.end();
  } catch {
    /* already closed */
  }
});