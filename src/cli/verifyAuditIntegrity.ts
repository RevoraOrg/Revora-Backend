#!/usr/bin/env node
/**
 * CLI: Verify audit log hash chain integrity.
 *
 * Usage: npm run verify-audit-integrity
 * Exit 0 on success, 1 on tamper detection or runtime error.
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { verifyAuditLogIntegrity } from '../security/auditHashChain';
import { globalMetrics } from '../lib/metrics';

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    return 1;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await verifyAuditLogIntegrity(pool);

    globalMetrics.setGauge('audit_integrity_valid', result.valid ? 1 : 0);
    globalMetrics.setGauge('audit_integrity_rows_verified', result.verifiedRows);
    globalMetrics.recordHistogram(
      'audit_integrity_verification_duration_ms',
      result.durationMs,
    );

    if (result.valid) {
      console.log(
        JSON.stringify({
          status: 'ok',
          totalRows: result.totalRows,
          verifiedRows: result.verifiedRows,
          durationMs: result.durationMs,
          headHash: result.headHash,
        }),
      );
      return 0;
    }

    console.error(
      JSON.stringify({
        status: 'failed',
        totalRows: result.totalRows,
        verifiedRows: result.verifiedRows,
        durationMs: result.durationMs,
        failure: result.failure,
      }),
    );
    globalMetrics.incrementCounter('audit_integrity_failures_total', {
      failure_type: result.failure?.type ?? 'unknown',
    });
    return 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}

export { main as runVerifyAuditIntegrityCli };
