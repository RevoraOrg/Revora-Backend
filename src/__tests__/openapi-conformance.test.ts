import supertest from 'supertest';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createApp } from '../index';
import path from 'path';

let spec: any;
let ajv: Ajv;
let app: any;

const enforceAdditionalProperties = (schema: any) => {
  if (!schema || typeof schema !== 'object') return;
  
  if (schema.type === 'object' && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  
  if (schema.properties) {
    for (const key in schema.properties) {
      enforceAdditionalProperties(schema.properties[key]);
    }
  }
  if (schema.items) {
    enforceAdditionalProperties(schema.items);
  }
  if (schema.oneOf) schema.oneOf.forEach(enforceAdditionalProperties);
  if (schema.anyOf) schema.anyOf.forEach(enforceAdditionalProperties);
  if (schema.allOf) schema.allOf.forEach(enforceAdditionalProperties);
};

beforeAll(async () => {
  app = createApp();
  const specPath = path.resolve(__dirname, '../docs/openapi.yaml');
  spec = await SwaggerParser.dereference(specPath);
  
  ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  if (spec.paths) {
    for (const pathStr of Object.keys(spec.paths)) {
      for (const method of Object.keys(spec.paths[pathStr])) {
        const operation = spec.paths[pathStr][method];
        if (operation.responses) {
          for (const status of Object.keys(operation.responses)) {
            const response = operation.responses[status];
            if (response.content && response.content['application/json'] && response.content['application/json'].schema) {
              enforceAdditionalProperties(response.content['application/json'].schema);
            }
          }
        }
      }
    }
  }
});

const getPathWithParams = (pathStr: string) => {
  return pathStr.replace(/\{([^}]+)\}/g, (match, paramName) => {
    if (paramName === 'id') return '00000000-0000-0000-0000-000000000000';
    return 'dummy';
  });
};

describe('OpenAPI Conformance', () => {
  it('should validate all operations', async () => {
    if (!spec.paths) return;
    
    const errors: string[] = [];

    for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathObj as any)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

        let requestPath = getPathWithParams(pathStr);
        if (requestPath.startsWith('/api/')) {
          requestPath = '/api/v1' + requestPath.substring(4);
        }
        let req = (supertest(app) as any)[method](requestPath);
        
        if (['post', 'put', 'patch'].includes(method)) {
          req = req.send({});
        }

        const res = await req;
        const statusCode = res.status.toString();
        
        // Skip endpoints that are completely unmounted (handled by catch-all 404)
        if (statusCode === '404' && res.body?.message === 'Route not found') {
          continue;
        }
        
        const responses = (operation as any).responses;
        if (!responses) continue;
        
        if (!responses[statusCode] && !responses['default']) {
          errors.push(`Undocumented status code ${statusCode} for ${method.toUpperCase()} ${pathStr}`);
          continue;
        }

        const documentedResponse = responses[statusCode] || responses['default'];
        if (documentedResponse.content && documentedResponse.content['application/json']) {
          const schema = documentedResponse.content['application/json'].schema;
          try {
            const validate = ajv.compile(schema);
            const isValid = validate(res.body);
            if (!isValid) {
              errors.push(`Schema validation failed for ${method.toUpperCase()} ${pathStr} (${statusCode}): ` + ajv.errorsText(validate.errors) + ` | Body: ${JSON.stringify(res.body)}`);
            }
          } catch (err: any) {
             errors.push(`Failed to compile schema for ${method.toUpperCase()} ${pathStr}: ${err.message}`);
          }
        }
      }
    }
    
    if (errors.length > 0) {
      throw new Error(`Conformance errors:\n` + errors.join('\n'));
    }
  });
});
