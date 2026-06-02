/**
 * Route Latency Budget Configuration
 * 
 * Defines p99 latency budget targets for hot routes in the application.
 * These budgets are used to detect performance regressions and ensure
 * SLA compliance.
 * 
 * Security Assumptions:
 * - Budget values are conservative estimates with safety margins
 * - Budgets account for normal network jitter (5-10ms)
 * - Budgets do not account for catastrophic failure states
 * - Budget enforcement is for regression detection, not traffic gating
 * 
 * @module lib/latency-budgets
 */

/**
 * Latency budget configuration for a single route
 */
export interface LatencyBudgetConfig {
  /** Human-readable route identifier */
  name: string;
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** Route path pattern */
  path: string;
  /** P99 latency budget in milliseconds */
  p99BudgetMs: number;
  /** Optional description of the budget rationale */
  description?: string;
}

/**
 * Hot routes with documented p99 latency budgets
 * 
 * Rationale:
 * - /health: Simple database check with minimal processing (no auth)
 *   Budget: 200ms p99 accounts for network + single query
 * 
 * - /offerings/validation-matrix: Stateless validation endpoint
 *   Budget: 250ms p99 accounts for schema validation + processing
 * 
 * - POST /investments: Write-heavy with blockchain calls
 *   Budget: 500ms p99 accounts for DB insert + external RPC calls
 */
export const HOT_ROUTE_BUDGETS: LatencyBudgetConfig[] = [
  {
    name: 'Health Check',
    method: 'GET',
    path: '/api/v1/health',
    p99BudgetMs: 200,
    description: 'Simple health check with minimal processing',
  },
  {
    name: 'Offering Validation Matrix',
    method: 'POST',
    path: '/api/v1/offerings/validation-matrix',
    p99BudgetMs: 250,
    description: 'Stateless validation with schema checking',
  },
  {
    name: 'Create Investment',
    method: 'POST',
    path: '/api/investments',
    p99BudgetMs: 500,
    description: 'Write-heavy endpoint with potential external calls',
  },
];

/**
 * Get latency budget for a specific route
 * @param method HTTP method (GET, POST, etc.)
 * @param path Route path
 * @returns Latency budget config or undefined if not found
 */
export function getLatencyBudget(method: string, path: string): LatencyBudgetConfig | undefined {
  return HOT_ROUTE_BUDGETS.find(
    (budget) =>
      budget.method.toUpperCase() === method.toUpperCase() &&
      normalizePath(budget.path) === normalizePath(path)
  );
}

/**
 * Normalize route path for comparison
 * Handles both with and without leading slash
 * @param path Route path
 * @returns Normalized path
 */
function normalizePath(path: string): string {
  return path.replace(/^\/+/, '/').replace(/\/+$/, '');
}

/**
 * Get all budgeted routes for test execution
 * @returns Array of budgeted routes
 */
export function getAllBudgetedRoutes(): LatencyBudgetConfig[] {
  return [...HOT_ROUTE_BUDGETS];
}
