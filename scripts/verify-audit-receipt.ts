#!/usr/bin/env node
/**
 * Standalone CLI: Audit Log Receipt Verifier
 *
 * Verifies an audit log excerpt against a published receipt without requiring
 * application server execution or PostgreSQL database connection.
 *
 * Usage:
 *   npx ts-node scripts/verify-audit-receipt.ts --receipt <path-or-url> --excerpt <path-or-url>
 *   npx ts-node scripts/verify-audit-receipt.ts <receipt-path-or-url> <excerpt-path-or-url>
 *
 * Exit code 0 on success, 1 on verification failure or runtime error.
 */

import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import {
  AUDIT_LOG_GENESIS_HASH,
  AuditLogChainRow,
  buildAuditCanonicalPayload,
  computeAuditRowHash,
} from '../src/security/auditHashChain';

export interface AuditReceipt {
  version?: string;
  published_at?: string;
  start_prev_hash?: string;
  expected_head_hash?: string;
  total_rows?: number;
  start_id?: string;
  end_id?: string;
  signature?: string;
  metadata?: Record<string, unknown>;

  // Common field aliases for flexibility
  prev_hash?: string;
  initial_prev_hash?: string;
  head_hash?: string;
  final_hash?: string;
  final_row_hash?: string;
  row_hash?: string;
  count?: number;
  row_count?: number;
}

export type ReceiptVerificationFailureType =
  | 'INVALID_RECEIPT'
  | 'EMPTY_EXCERPT'
  | 'TRUNCATED_EXCERPT'
  | 'ROW_COUNT_MISMATCH'
  | 'START_HASH_MISMATCH'
  | 'BROKEN_CHAIN'
  | 'GAP_DETECTED'
  | 'HASH_MISMATCH'
  | 'HEAD_HASH_MISMATCH'
  | 'START_ID_MISMATCH'
  | 'END_ID_MISMATCH'
  | 'MISSING_HASHES';

export interface DerivationStep {
  index: number;
  rowId: string;
  timestamp: string;
  prevHashMatch: boolean;
  computedHash: string;
  storedHash: string;
  hashMatch: boolean;
  error?: string;
}

export interface ReceiptVerificationResult {
  valid: boolean;
  failureType?: ReceiptVerificationFailureType;
  message?: string;
  actionableRecommendation?: string;
  totalEntries: number;
  verifiedEntries: number;
  expectedEntries?: number;
  receiptHeadHash?: string;
  computedHeadHash?: string;
  derivationTrace: DerivationStep[];
  durationMs: number;
}

export interface CliOptions {
  receiptPathOrUrl?: string;
  excerptPathOrUrl?: string;
  jsonOutput?: boolean;
  quiet?: boolean;
  help?: boolean;
}

/**
 * Fetch content from HTTP/HTTPS URL or read from local filesystem.
 */
export async function loadContent(inputPathOrUrl: string): Promise<string> {
  if (/^https?:\/\//i.test(inputPathOrUrl)) {
    const client = inputPathOrUrl.toLowerCase().startsWith('https') ? https : http;
    return new Promise((resolve, reject) => {
      client
        .get(inputPathOrUrl, (res) => {
          const status = res.statusCode || 200;
          if (status >= 400) {
            return reject(
              new Error(`HTTP ${status} fetching ${inputPathOrUrl}`),
            );
          }
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        })
        .on('error', reject);
    });
  }

  const resolvedPath = path.resolve(process.cwd(), inputPathOrUrl);
  return fs.promises.readFile(resolvedPath, 'utf8');
}

/**
 * Parse log excerpt content from JSON array or newline-delimited JSON (JSONL).
 */
export function parseLogExcerpt(content: string): AuditLogChainRow[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  let rawRows: any[] = [];
  if (trimmed.startsWith('[')) {
    rawRows = JSON.parse(trimmed);
  } else {
    rawRows = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  return rawRows.map((r) => ({
    id: String(r.id ?? ''),
    user_id: r.user_id == null ? null : String(r.user_id),
    action: String(r.action ?? ''),
    resource: r.resource == null ? null : String(r.resource),
    details: r.details == null ? null : String(r.details),
    ip_address: r.ip_address == null ? null : String(r.ip_address),
    user_agent: r.user_agent == null ? null : String(r.user_agent),
    created_at:
      r.created_at instanceof Date
        ? r.created_at
        : new Date(typeof r.created_at === 'number' ? r.created_at : String(r.created_at)),
    prev_hash: String(r.prev_hash ?? ''),
    row_hash: String(r.row_hash ?? ''),
  }));
}

/**
 * Normalize receipt options taking alias fields into account.
 */
export function normalizeReceipt(rawReceipt: AuditReceipt): AuditReceipt {
  return {
    ...rawReceipt,
    start_prev_hash:
      rawReceipt.start_prev_hash ??
      rawReceipt.initial_prev_hash ??
      rawReceipt.prev_hash,
    expected_head_hash:
      rawReceipt.expected_head_hash ??
      rawReceipt.head_hash ??
      rawReceipt.final_hash ??
      rawReceipt.final_row_hash ??
      rawReceipt.row_hash,
    total_rows:
      rawReceipt.total_rows ?? rawReceipt.count ?? rawReceipt.row_count,
  };
}

/**
 * Perform hash chain reconstruction and verify excerpt against receipt.
 */
export function verifyAuditReceipt(
  rawReceipt: AuditReceipt,
  entries: AuditLogChainRow[],
): ReceiptVerificationResult {
  const startTime = Date.now();
  const receipt = normalizeReceipt(rawReceipt);

  const derivationTrace: DerivationStep[] = [];

  const expectedCount = receipt.total_rows;
  const expectedHeadHash = receipt.expected_head_hash;
  const startPrevHash = receipt.start_prev_hash;

  if (entries.length === 0) {
    if (expectedCount === 0) {
      return {
        valid: true,
        totalEntries: 0,
        verifiedEntries: 0,
        expectedEntries: 0,
        derivationTrace: [],
        durationMs: Date.now() - startTime,
      };
    }
    return {
      valid: false,
      failureType: 'EMPTY_EXCERPT',
      message: 'Log excerpt contains 0 entries.',
      actionableRecommendation:
        'Provide a log excerpt containing audit log entries matching the receipt period.',
      totalEntries: 0,
      verifiedEntries: 0,
      expectedEntries: expectedCount,
      derivationTrace: [],
      durationMs: Date.now() - startTime,
    };
  }

  // Sort rows in deterministic chain sequence: created_at ASC, id ASC
  const sorted = [...entries].sort((a, b) => {
    const tDiff = a.created_at.getTime() - b.created_at.getTime();
    if (tDiff !== 0) return tDiff;
    return a.id.localeCompare(b.id);
  });

  // Check truncation / count mismatch
  if (expectedCount !== undefined && sorted.length !== expectedCount) {
    const startIdStr = receipt.start_id ?? 'N/A';
    const endIdStr = receipt.end_id ?? 'N/A';
    if (sorted.length < expectedCount) {
      return {
        valid: false,
        failureType: 'TRUNCATED_EXCERPT',
        message: `Log excerpt is truncated: received ${sorted.length} entries, but receipt expected ${expectedCount} entries.`,
        actionableRecommendation: `Ensure the log export includes all ${expectedCount} entries without truncation from start_id (${startIdStr}) to end_id (${endIdStr}).`,
        totalEntries: sorted.length,
        verifiedEntries: 0,
        expectedEntries: expectedCount,
        receiptHeadHash: expectedHeadHash,
        derivationTrace: [],
        durationMs: Date.now() - startTime,
      };
    } else {
      return {
        valid: false,
        failureType: 'ROW_COUNT_MISMATCH',
        message: `Log excerpt count (${sorted.length}) exceeds receipt expected row count (${expectedCount}).`,
        actionableRecommendation:
          'Verify that the log excerpt range strictly corresponds to the receipt bounds.',
        totalEntries: sorted.length,
        verifiedEntries: 0,
        expectedEntries: expectedCount,
        receiptHeadHash: expectedHeadHash,
        derivationTrace: [],
        durationMs: Date.now() - startTime,
      };
    }
  }

  // Check start ID if specified
  if (receipt.start_id && sorted[0].id !== receipt.start_id) {
    return {
      valid: false,
      failureType: 'START_ID_MISMATCH',
      message: `First entry ID (${sorted[0].id}) does not match receipt start_id (${receipt.start_id}).`,
      actionableRecommendation: `Include the starting entry with ID ${receipt.start_id}.`,
      totalEntries: sorted.length,
      verifiedEntries: 0,
      expectedEntries: expectedCount,
      derivationTrace: [],
      durationMs: Date.now() - startTime,
    };
  }

  // Check end ID if specified
  if (receipt.end_id && sorted[sorted.length - 1].id !== receipt.end_id) {
    return {
      valid: false,
      failureType: 'END_ID_MISMATCH',
      message: `Last entry ID (${sorted[sorted.length - 1].id}) does not match receipt end_id (${receipt.end_id}).`,
      actionableRecommendation: `Include ending entry with ID ${receipt.end_id}.`,
      totalEntries: sorted.length,
      verifiedEntries: 0,
      expectedEntries: expectedCount,
      derivationTrace: [],
      durationMs: Date.now() - startTime,
    };
  }

  // Check start_prev_hash anchor if specified
  let expectedPrev = startPrevHash ?? AUDIT_LOG_GENESIS_HASH;
  if (startPrevHash !== undefined && sorted[0].prev_hash !== startPrevHash) {
    return {
      valid: false,
      failureType: 'START_HASH_MISMATCH',
      message: `First entry prev_hash (${sorted[0].prev_hash}) does not match receipt start_prev_hash (${startPrevHash}).`,
      actionableRecommendation:
        'Verify that the excerpt starts at the exact initial prev_hash recorded in the published receipt.',
      totalEntries: sorted.length,
      verifiedEntries: 0,
      expectedEntries: expectedCount,
      receiptHeadHash: expectedHeadHash,
      derivationTrace: [],
      durationMs: Date.now() - startTime,
    };
  }

  let verifiedEntries = 0;

  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index];

    if (!row.prev_hash || !row.row_hash) {
      const step: DerivationStep = {
        index,
        rowId: row.id,
        timestamp: row.created_at.toISOString(),
        prevHashMatch: false,
        computedHash: '',
        storedHash: row.row_hash,
        hashMatch: false,
        error: 'Missing prev_hash or row_hash in excerpt row',
      };
      derivationTrace.push(step);
      return {
        valid: false,
        failureType: 'MISSING_HASHES',
        message: `Row index ${index} (ID: ${row.id}) is missing required prev_hash or row_hash fields.`,
        actionableRecommendation:
          'Ensure all excerpt entries include prev_hash and row_hash fields.',
        totalEntries: sorted.length,
        verifiedEntries,
        expectedEntries: expectedCount,
        receiptHeadHash: expectedHeadHash,
        derivationTrace,
        durationMs: Date.now() - startTime,
      };
    }

    const prevHashMatch = row.prev_hash === expectedPrev;
    if (!prevHashMatch) {
      const step: DerivationStep = {
        index,
        rowId: row.id,
        timestamp: row.created_at.toISOString(),
        prevHashMatch: false,
        computedHash: '',
        storedHash: row.row_hash,
        hashMatch: false,
        error: `Prev hash mismatch: expected ${expectedPrev}, found ${row.prev_hash}`,
      };
      derivationTrace.push(step);

      const isGenesis = index === 0;
      return {
        valid: false,
        failureType: isGenesis ? 'BROKEN_CHAIN' : 'GAP_DETECTED',
        message: isGenesis
          ? `Genesis chain anchor broken at entry ${row.id}: prev_hash does not match genesis constant.`
          : `Chain gap or deleted entry before ${row.id} at index ${index}: prev_hash (${row.prev_hash}) does not match prior row_hash (${expectedPrev}).`,
        actionableRecommendation:
          'Check for deleted entries or missing rows in the provided log excerpt sequence.',
        totalEntries: sorted.length,
        verifiedEntries,
        expectedEntries: expectedCount,
        receiptHeadHash: expectedHeadHash,
        derivationTrace,
        durationMs: Date.now() - startTime,
      };
    }

    const computedHash = computeAuditRowHash(row);
    const hashMatch = computedHash === row.row_hash;

    const step: DerivationStep = {
      index,
      rowId: row.id,
      timestamp: row.created_at.toISOString(),
      prevHashMatch: true,
      computedHash,
      storedHash: row.row_hash,
      hashMatch,
    };
    derivationTrace.push(step);

    if (!hashMatch) {
      step.error = `Row payload hash mismatch: computed ${computedHash}, stored ${row.row_hash}`;
      return {
        valid: false,
        failureType: 'HASH_MISMATCH',
        message: `Tampered audit log entry detected at index ${index} (ID: ${row.id}): canonical payload hash (${computedHash}) does not match stored row_hash (${row.row_hash}).`,
        actionableRecommendation:
          'Audit log payload integrity check failed. The row content has been modified after hash generation.',
        totalEntries: sorted.length,
        verifiedEntries,
        expectedEntries: expectedCount,
        receiptHeadHash: expectedHeadHash,
        derivationTrace,
        durationMs: Date.now() - startTime,
      };
    }

    expectedPrev = row.row_hash;
    verifiedEntries++;
  }

  const computedHeadHash = sorted[sorted.length - 1].row_hash;

  if (expectedHeadHash !== undefined && computedHeadHash !== expectedHeadHash) {
    return {
      valid: false,
      failureType: 'HEAD_HASH_MISMATCH',
      message: `Final excerpt head hash (${computedHeadHash}) does not match receipt expected_head_hash (${expectedHeadHash}).`,
      actionableRecommendation:
        'The log excerpt does not reach the published receipt head commitment. Ensure the excerpt is complete up to the receipt commit point.',
      totalEntries: sorted.length,
      verifiedEntries,
      expectedEntries: expectedCount,
      receiptHeadHash: expectedHeadHash,
      computedHeadHash,
      derivationTrace,
      durationMs: Date.now() - startTime,
    };
  }

  return {
    valid: true,
    totalEntries: sorted.length,
    verifiedEntries,
    expectedEntries: expectedCount ?? sorted.length,
    receiptHeadHash: expectedHeadHash ?? computedHeadHash,
    computedHeadHash,
    derivationTrace,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Format verification result as human-readable report.
 */
export function formatReport(
  result: ReceiptVerificationResult,
  receiptSource?: string,
  excerptSource?: string,
  quiet?: boolean,
): string {
  const lines: string[] = [];
  lines.push('============================================================');
  lines.push('AUDIT LOG INTEGRITY VERIFICATION REPORT');
  lines.push('============================================================');
  if (receiptSource) lines.push(`Receipt Source:    ${receiptSource}`);
  if (excerptSource) lines.push(`Excerpt Source:    ${excerptSource}`);
  lines.push(
    `Status:            ${result.valid ? 'PASS [VALID INTEGRITY PROOF]' : 'FAIL [TAMPER OR INVALID PROOF]'}`,
  );
  lines.push(`Total Entries:     ${result.totalEntries}`);
  lines.push(`Verified Entries:  ${result.verifiedEntries}`);
  lines.push(`Duration:          ${result.durationMs}ms`);

  if (result.receiptHeadHash) {
    lines.push(`Receipt Head Hash: ${result.receiptHeadHash}`);
  }
  if (result.computedHeadHash) {
    lines.push(`Computed Head Hash:${result.computedHeadHash}`);
  }

  if (!quiet) {
    lines.push('------------------------------------------------------------');
    lines.push('DERIVATION TRACE:');
    lines.push('------------------------------------------------------------');

    if (result.derivationTrace.length === 0) {
      lines.push('(No derivation steps executed due to early validation failure)');
    } else {
      for (const step of result.derivationTrace) {
        lines.push(
          `[Row ${step.index + 1}] ID: ${step.rowId} (${step.timestamp})`,
        );
        lines.push(
          `        Prev Hash Link: ${step.prevHashMatch ? 'OK' : 'BROKEN'}`,
        );
        lines.push(
          `        Payload Hash:   ${step.hashMatch ? 'OK' : 'MISMATCH'} (Computed: ${step.computedHash || 'N/A'})`,
        );
        if (step.error) {
          lines.push(`        Error:          ${step.error}`);
        }
      }
    }
  }

  lines.push('------------------------------------------------------------');

  if (result.valid) {
    lines.push('VERIFICATION RESULT: SUCCESS');
    lines.push(
      `All ${result.verifiedEntries} audit log entries cryptographically link to published receipt.`,
    );
  } else {
    lines.push(`VERIFICATION RESULT: FAILURE [${result.failureType}]`);
    lines.push(`Error Details:  ${result.message}`);
    if (result.actionableRecommendation) {
      lines.push(`Action Required:${result.actionableRecommendation}`);
    }
  }

  lines.push('============================================================');
  return lines.join('\n');
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--receipt' || arg === '-r') {
      options.receiptPathOrUrl = args[++i];
    } else if (arg === '--excerpt' || arg === '-e' || arg === '--entries') {
      options.excerptPathOrUrl = args[++i];
    } else if (arg === '--json') {
      options.jsonOutput = true;
    } else if (arg === '--quiet' || arg === '-q') {
      options.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (!options.receiptPathOrUrl && positional.length > 0) {
    options.receiptPathOrUrl = positional.shift();
  }
  if (!options.excerptPathOrUrl && positional.length > 0) {
    options.excerptPathOrUrl = positional.shift();
  }

  return options;
}

export function printHelp(): void {
  console.log(`
Audit Log Receipt Verifier CLI

Usage:
  npx ts-node scripts/verify-audit-receipt.ts --receipt <path-or-url> --excerpt <path-or-url>
  npx ts-node scripts/verify-audit-receipt.ts <receipt-file-or-url> <excerpt-file-or-url>

Options:
  -r, --receipt <path-or-url>   Path or HTTP URL to receipt JSON
  -e, --excerpt <path-or-url>   Path or HTTP URL to log excerpt JSON or JSONL
  --json                        Print machine-readable JSON report
  -q, --quiet                   Suppress detailed derivation trace in output
  -h, --help                    Display this help message
`);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseCliArgs(argv);

  if (options.help) {
    printHelp();
    return 0;
  }

  if (!options.receiptPathOrUrl) {
    console.error('Error: Both receipt and excerpt paths/URLs must be specified.');
    printHelp();
    return 1;
  }
  if (!options.excerptPathOrUrl) {
    console.error('Error: Both receipt and excerpt paths/URLs must be specified.');
    printHelp();
    return 1;
  }

  try {
    const [receiptRaw, excerptRaw] = await Promise.all([
      loadContent(options.receiptPathOrUrl),
      loadContent(options.excerptPathOrUrl),
    ]);

    const receipt: AuditReceipt = JSON.parse(receiptRaw);
    const entries = parseLogExcerpt(excerptRaw);

    const result = verifyAuditReceipt(receipt, entries);

    if (options.jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        formatReport(
          result,
          options.receiptPathOrUrl,
          options.excerptPathOrUrl,
          options.quiet,
        ),
      );
    }

    return result.valid ? 0 : 1;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (options.jsonOutput) {
      console.log(
        JSON.stringify({
          valid: false,
          failureType: 'RUNTIME_ERROR',
          message: errorMessage,
        }),
      );
    } else {
      console.error(`\n[VERIFIER ERROR] Failed to execute verification: ${errorMessage}`);
    }
    return 1;
  }
}

/* istanbul ignore next */
if (require.main === module) {
  runCli()
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
