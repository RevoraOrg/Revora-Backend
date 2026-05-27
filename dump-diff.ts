import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import listEndpoints from 'express-list-endpoints';
import { createApp } from './src/index';

const specPath = path.resolve(__dirname, './src/docs/openapi.yaml');
const specRaw = fs.readFileSync(specPath, 'utf8');
const spec = yaml.load(specRaw) as any;

const app = createApp();
const endpoints = listEndpoints(app);

const expressRoutes = new Set<string>();
endpoints.forEach(endpoint => {
  endpoint.methods.forEach(method => {
    const openApiPath = endpoint.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    expressRoutes.add(`${method.toLowerCase()} ${openApiPath}`);
  });
});

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

console.log('MISSING:', JSON.stringify(missingInSpec, null, 2));
console.log('EXTRA:', JSON.stringify(extraInSpec, null, 2));
