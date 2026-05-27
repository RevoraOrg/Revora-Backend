import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import listEndpoints from 'express-list-endpoints';
import { createApp } from '../index';

describe('OpenAPI Spec Parity', () => {
  it('should match the actually served routes', () => {
    const specPath = path.resolve(__dirname, '../docs/openapi.yaml');
    const specRaw = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specRaw) as any;

    const app = createApp();
    const endpoints = listEndpoints(app);

    // Collect endpoints from Express
    const expressRoutes = new Set<string>();
    endpoints.forEach(endpoint => {
      endpoint.methods.forEach(method => {
        // Express list endpoints converts paths like /api/v1/offerings/:id to /api/v1/offerings/:id
        // OpenAPI uses {id} instead of :id. Let's map it.
        const openApiPath = endpoint.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
        expressRoutes.add(`${method.toLowerCase()} ${openApiPath}`);
      });
    });

    // Collect endpoints from OpenAPI spec
    const openApiRoutes = new Set<string>();
    if (spec.paths) {
      for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
        for (const [method, _] of Object.entries(pathObj as any)) {
          if (['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(method)) {
            openApiRoutes.add(`${method} ${pathStr}`);
          }
        }
      }
    }

    const missingInSpec = Array.from(expressRoutes).filter(route => !openApiRoutes.has(route));
    const extraInSpec = Array.from(openApiRoutes).filter(route => !expressRoutes.has(route));

    if (missingInSpec.length > 0 || extraInSpec.length > 0) {
      console.log('Missing in Spec:', missingInSpec);
      console.log('Extra in Spec (Unmounted):', extraInSpec);
    }

    expect(missingInSpec).toEqual([]);
    expect(extraInSpec).toEqual([]);
  });
});
