import listEndpoints from 'express-list-endpoints';
import { Express } from 'express';

/**
 * @notice Standard HTTP verbs allowed for RBAC and security route auditing.
 * @dev Non-standard or auxiliary HTTP methods (e.g. OPTIONS, HEAD, TRACE) are excluded by default.
 */
export const ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * @notice Represents an enumerated HTTP route endpoint and its associated method.
 * @dev Used for programmatic authorization auditing, fuzz testing, and contract verification.
 * @param path The relative URL path of the route (e.g., '/api/v1/users/:id').
 * @param method The normalized uppercase HTTP verb (e.g., 'GET', 'POST').
 */
export interface RouteEntry {
  path: string;
  method: string;
}

/**
 * @notice Enumerates all registered HTTP routes and their allowed methods from an Express application or router.
 * @dev Introspects the Express routing layer via express-list-endpoints and normalizes methods to uppercase.
 * Validates input presence and ensures non-standard HTTP methods are filtered out.
 *
 * @param app The Express application instance (or router) to introspect.
 * @returns Array of RouteEntry objects representing each registered endpoint and method pair.
 * @throws {TypeError} If the provided app is null, undefined, or not an object/function.
 */
export function enumerateRoutes(app: Express): RouteEntry[] {
  if (!app || (typeof app !== 'object' && typeof app !== 'function')) {
    throw new TypeError('Expected an Express application or router instance, received: ' + String(app));
  }

  let endpoints: ReturnType<typeof listEndpoints> = [];
  try {
    const result = listEndpoints(app);
    if (Array.isArray(result)) {
      endpoints = result;
    }
  } catch {
    return [];
  }

  const routes: RouteEntry[] = [];

  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.path !== 'string' || !Array.isArray(endpoint.methods)) {
      continue;
    }

    for (const method of endpoint.methods) {
      if (typeof method !== 'string') {
        continue;
      }
      const upperMethod = method.toUpperCase();
      if (ALLOWED_METHODS.includes(upperMethod)) {
        routes.push({ path: endpoint.path, method: upperMethod });
      }
    }
  }

  return routes;
}


