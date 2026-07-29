#!/usr/bin/env node
/**
 * CLI: Reconciliation Replay
 *
 * Re-runs a single reconciliation period against an archived Horizon snapshot
 * to prove or refute drift anomalies detected late. Writes a signed JSON report
 * to stdout.
 *
 * Usage:
 *   npx ts-node scripts/reconcile-replay.ts <offering_id> <period_start> <horizon_fixture_url> [period_end]
 *
 * Arguments:
 *   offering_id          - The offering ID to reconcile.
 *   period_start         - ISO-8601 start date of the reconciliation window.
 *   horizon_fixture_url  - URL to an archived Horizon fixture (JSON).
 *   period_end           - Optional ISO-8601 end date (default: now).
 *
 * Security assumptions:
 *   - The fixture URL is trusted (operator-supplied).
 *   - DATABASE_URL and REPLAY_SIGNING_SECRET are set in the environment.
 *   - The fixture is fetched once and its SHA-256 is recorded in the report
 *     for auditability.
 *
 * Edge cases handled:
 *   - Missing or inaccessible fixture → actionable error message, exit 1.
 *   - Fixture returns non-JSON or empty body → exit 1 with diagnostic.
 *   - DB connection failure → exit 1.
 *   - Reconciliation service throws → exit 1 with error details.
 */

import 'dotenv/config';
import { createHash, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { RevenueReconciliationService } from '../src/services/revenueReconciliationService';
import { globalMetrics } from '../src/lib/metrics';
import type { OnChainRevenueState, StellarRevenueClient, ReconciliationResult } from '../src/services/revenueReconciliationService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HorizonFixture {
  totalDistributed: string;
  [key: string]: unknown;
}

interface ReplayReport {
  schema_version: 1;
  generated_at: string;
  fixture_sha256: string;
  fixture_url: string;
  parameters: {
    offering_id: string;
    period_start: string;
    period_end: string;
  };
  reconciliation: ReconciliationResult;
}

interface SignedReport {
  report: ReplayReport;
  signature: string;
}

// ---------------------------------------------------------------------------
// Horizon Fixture Adapter
// ---------------------------------------------------------------------------

/**
 * StellarRevenueClient implementation that reads on-chain state from an
 * archived Horizon fixture instead of making live RPC calls.
 */
class HorizonFixtureClient implements StellarRevenueClient {
  constructor(private readonly fixture: HorizonFixture) {}

  async getRevenueState(_contractAddress: string): Promise<OnChainRevenueState> {
    return {
      totalDistributed: this.fixture.totalDistributed ?? '0.00',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a Horizon fixture from a URL and validate the response.
 * @throws If the fixture is inaccessible, empty, or not valid JSON.
 */
async function fetchHorizonFixture(url: string): Promise<{ body: string; data: HorizonFixture }> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to connect to fixture URL "${url}": ${err instanceof Error ? err.message : String(err)}. ` +
      'Verify the URL is reachable and points to a valid Horizon snapshot.'
    );
  }

  if (!response.ok) {
    throw new Error(
      `Fixture URL returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}. ` +
      'The archived Horizon snapshot may be missing or inaccessible. ' +
      `Check that the fixture exists at "${url}".`
    );
  }

  const body = await response.text();

  if (!body || body.trim().length === 0) {
    throw new Error(
      `Fixture URL "${url}" returned an empty response body. ` +
      'The archived snapshot appears to contain no data.'
    );
  }

  let data: HorizonFixture;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(
      `Fixture URL "${url}" returned non-JSON content. ` +
      'Ensure the URL points to a valid Horizon snapshot JSON file.'
    );
  }

  return { body, data };
}

/**
 * Compute the SHA-256 hex digest of a string.
 */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Sign a report payload using HMAC-SHA256.
 *
 * @param report  - The report to sign.
 * @param secret  - The HMAC signing secret (validated upstream).
 */
function signReport(report: ReplayReport, secret: string): string {
  const canonical = JSON.stringify(report);
  const hmac = createHmac('sha256', secret);
  hmac.update(canonical);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Format a Date to an ISO-8601 string with second precision.
 */
function formatDate(date: Date): string {
  return date.toISOString();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  // Help / usage
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      'Usage: npx ts-node scripts/reconcile-replay.ts <offering_id> <period_start> <horizon_fixture_url> [period_end]',
      '',
      'Arguments:',
      '  offering_id          The offering ID to reconcile.',
      '  period_start         ISO-8601 start date (e.g. 2023-01-01).',
      '  horizon_fixture_url  URL to an archived Horizon snapshot (JSON).',
      '  period_end           Optional ISO-8601 end date (default: now).',
      '',
      'Environment:',
      '  DATABASE_URL            PostgreSQL connection string.',
      '  REPLAY_SIGNING_SECRET   HMAC-SHA256 secret for signing the report.',
      '',
      'Example:',
      '  npx ts-node scripts/reconcile-replay.ts offering-abc 2023-01-01 https://archive.example.com/horizon-2023-01.json',
    ].join('\n'));
    return 0;
  }

  if (args.length < 3) {
    console.error('Error: Missing required arguments. Use --help for usage.');
    return 1;
  }

  const [offeringId, periodStartStr, fixtureUrl, periodEndStr] = args;

  // Validate and parse dates
  const periodStart = new Date(periodStartStr);
  if (isNaN(periodStart.getTime())) {
    console.error(`Error: Invalid period_start "${periodStartStr}". Expected ISO-8601 date (e.g. 2023-01-01).`);
    return 1;
  }

  let periodEnd: Date;
  if (periodEndStr) {
    periodEnd = new Date(periodEndStr);
    if (isNaN(periodEnd.getTime())) {
      console.error(`Error: Invalid period_end "${periodEndStr}". Expected ISO-8601 date (e.g. 2023-01-31).`);
      return 1;
    }
  } else {
    periodEnd = new Date();
  }

  if (periodEnd <= periodStart) {
    console.error('Error: period_end must be after period_start.');
    return 1;
  }

  // Validate offering ID
  if (!offeringId || typeof offeringId !== 'string' || offeringId.trim().length === 0) {
    console.error('Error: offering_id must be a non-empty string.');
    return 1;
  }

  // Fetch the Horizon fixture
  console.error(`Fetching Horizon fixture from ${fixtureUrl}...`);
  let fixtureBody: string;
  let fixtureData: HorizonFixture;

  try {
    const result = await fetchHorizonFixture(fixtureUrl);
    fixtureBody = result.body;
    fixtureData = result.data;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    globalMetrics.incrementCounter('reconciliation_replay_errors_total', {
      error_type: 'fixture_fetch_failed',
    });
    return 1;
  }

  const fixtureSha256 = sha256(fixtureBody);
  console.error(`Fixture SHA-256: ${fixtureSha256}`);

  // Connect to the database
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is required.');
    return 1;
  }

  // Validate signing secret before creating the DB pool so we never leak a
  // connection when the secret is missing.
  const signingSecret = process.env.REPLAY_SIGNING_SECRET;
  if (!signingSecret) {
    console.error(
      'Error: REPLAY_SIGNING_SECRET is required to sign the replay report. ' +
      'Set it in the environment before running this CLI.'
    );
    return 1;
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Create the Horizon fixture client adapter
    const fixtureClient = new HorizonFixtureClient(fixtureData);

    // Build the reconciliation service (no tx verifier for replay – we trust the fixture)
    const service = new RevenueReconciliationService(pool, fixtureClient);

    console.error(
      `Running reconciliation for offering ${offeringId} ` +
      `from ${formatDate(periodStart)} to ${formatDate(periodEnd)}...`
    );

    const reconciliation = await service.reconcile(
      offeringId,
      periodStart,
      periodEnd,
      { checkInvestorAllocations: false, checkRoundingAdjustments: false }
    );

    // Build the replay report
    const report: ReplayReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      fixture_sha256: fixtureSha256,
      fixture_url: fixtureUrl,
      parameters: {
        offering_id: offeringId,
        period_start: formatDate(periodStart),
        period_end: formatDate(periodEnd),
      },
      reconciliation,
    };

    // Sign the report
    const signature = signReport(report, signingSecret);

    const signedReport: SignedReport = { report, signature };

    // Emit to stdout (JSON)
    console.log(JSON.stringify(signedReport, null, 2));

    // Record metrics
    globalMetrics.incrementCounter('reconciliation_replay_completed_total', {
      offering_id: offeringId,
      is_balanced: String(reconciliation.isBalanced),
    });
    globalMetrics.setGauge(
      'reconciliation_replay_discrepancies',
      reconciliation.discrepancies.length,
      { offering_id: offeringId }
    );

    const hasCriticalErrors = reconciliation.discrepancies.some(
      (d) => d.severity === 'critical'
    );
    const hasErrors = reconciliation.discrepancies.some(
      (d) => d.severity === 'error'
    );

    console.error('');
    console.error('Reconciliation replay complete.');
    console.error(`  Balanced: ${reconciliation.isBalanced}`);
    console.error(`  Discrepancies: ${reconciliation.discrepancies.length}`);
    console.error(`  Critical errors: ${hasCriticalErrors}`);
    console.error(`  Errors: ${hasErrors}`);

    return reconciliation.isBalanced ? 0 : 1;
  } catch (err) {
    console.error(
      `Error: Reconciliation replay failed: ${err instanceof Error ? err.message : String(err)}`
    );
    globalMetrics.incrementCounter('reconciliation_replay_errors_total', {
      error_type: 'reconciliation_failed',
    });
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

export { main as runReconcileReplayCli, fetchHorizonFixture, HorizonFixtureClient, signReport };
export type { ReplayReport, SignedReport, HorizonFixture };
