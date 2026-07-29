import listEndpoints from 'express-list-endpoints';
import { Express } from 'express';

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface RouteEntry {
  path: string;
  method: string;
}

export function enumerateRoutes(app: Express): RouteEntry[] {
  const endpoints = listEndpoints(app);
  const routes: RouteEntry[] = [];

  for (const endpoint of endpoints) {
    for (const method of endpoint.methods) {
      if (ALLOWED_METHODS.includes(method.toUpperCase())) {
        routes.push({ path: endpoint.path, method: method.toUpperCase() });
      }
    }
  }

  return routes;
}
