/**
 * Tamper-evident append-only hash chain for audit_logs.
 *
 * Each row links to the previous row via prev_hash and stores row_hash computed
 * from a canonical payload. Verification walks the chain in created_at/id order
 * and detects edits, deletes, and mid-chain tampering.
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';

/** Genesis anchor — must match audit_log_genesis_hash() in migration 013. */
export const AUDIT_LOG_GENESIS_HASH = createHash('sha256')
  .update('REVORA_AUDIT_LOG_GENESIS_v1')
  .digest('hex');

export type AuditIntegrityFailureType =
  | 'missing_hashes'
  | 'hash_mismatch'
  | 'broken_chain'
  | 'gap_detected';

export interface AuditLogChainRow {
  id: string;
  user_id: string | null;
  action: string;
  resource: string | null;
  details: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
  prev_hash: string;
  row_hash: string;
}

export interface AuditIntegrityFailure {
  type: AuditIntegrityFailureType;
  rowId: string;
  index: number;
  message: string;
}

export interface AuditIntegrityResult {
  valid: boolean;
  totalRows: number;
  verifiedRows: number;
  durationMs: number;
  headHash: string | null;
  failure?: AuditIntegrityFailure;
}

function nullToEmpty(value: string | null | undefined): string {
  return value ?? '';
}

function formatIpAddress(ip: string | null): string {
  if (!ip) return '';
  // pg returns INET as "192.168.1.1" or "192.168.1.1/32"
  return ip.split('/')[0];
}

function formatTimestampMs(date: Date): string {
  return String(date.getTime());
}

/**
 * Canonical pipe-delimited payload hashed into row_hash.
 * Field order and formatting must match audit_log_canonical_payload() in SQL.
 */
export function buildAuditCanonicalPayload(
  row: Omit<AuditLogChainRow, 'row_hash'>,
): string {
  return [
    nullToEmpty(row.id),
    nullToEmpty(row.user_id),
    nullToEmpty(row.action),
    nullToEmpty(row.resource),
    nullToEmpty(row.details),
    formatIpAddress(row.ip_address),
    nullToEmpty(row.user_agent),
    formatTimestampMs(row.created_at),
    nullToEmpty(row.prev_hash),
  ].join('|');
}

/** Compute SHA-256 row_hash for a chain row (excluding stored row_hash). */
export function computeAuditRowHash(
  row: Omit<AuditLogChainRow, 'row_hash'>,
): string {
  return createHash('sha256')
    .update(buildAuditCanonicalPayload(row))
    .digest('hex');
}

function mapDbRow(row: Record<string, unknown>): AuditLogChainRow {
  return {
    id: String(row.id),
    user_id: row.user_id == null ? null : String(row.user_id),
    action: String(row.action),
    resource: row.resource == null ? null : String(row.resource),
    details: row.details == null ? null : String(row.details),
    ip_address: row.ip_address == null ? null : String(row.ip_address),
    user_agent: row.user_agent == null ? null : String(row.user_agent),
    created_at: row.created_at instanceof Date
      ? row.created_at
      : new Date(String(row.created_at)),
    prev_hash: String(row.prev_hash),
    row_hash: String(row.row_hash),
  };
}

/**
 * Verify an in-memory audit log chain (used by tests and DB verifier).
 */
export function verifyAuditHashChain(rows: AuditLogChainRow[]): AuditIntegrityResult {
  const start = Date.now();
  const sorted = [...rows].sort((a, b) => {
    const timeDiff = a.created_at.getTime() - b.created_at.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  let expectedPrev = AUDIT_LOG_GENESIS_HASH;
  let verifiedRows = 0;
  let headHash: string | null = null;

  for (let index = 0; index < sorted.length; index++) {
    const row = sorted[index];

    if (!row.prev_hash || !row.row_hash) {
      return {
        valid: false,
        totalRows: sorted.length,
        verifiedRows,
        durationMs: Date.now() - start,
        headHash,
        failure: {
          type: 'missing_hashes',
          rowId: row.id,
          index,
          message: `Row ${row.id} is missing prev_hash or row_hash`,
        },
      };
    }

    if (row.prev_hash !== expectedPrev) {
      return {
        valid: false,
        totalRows: sorted.length,
        verifiedRows,
        durationMs: Date.now() - start,
        headHash,
        failure: {
          type: index === 0 ? 'broken_chain' : 'gap_detected',
          rowId: row.id,
          index,
          message:
            index === 0
              ? `Genesis chain broken at row ${row.id}`
              : `Chain gap or deleted row before ${row.id}: prev_hash does not match prior row_hash`,
        },
      };
    }

    const computed = computeAuditRowHash(row);
    if (computed !== row.row_hash) {
      return {
        valid: false,
        totalRows: sorted.length,
        verifiedRows,
        durationMs: Date.now() - start,
        headHash,
        failure: {
          type: 'hash_mismatch',
          rowId: row.id,
          index,
          message: `Tampered row detected at ${row.id}: stored row_hash does not match payload`,
        },
      };
    }

    expectedPrev = row.row_hash;
    headHash = row.row_hash;
    verifiedRows++;
  }

  return {
    valid: true,
    totalRows: sorted.length,
    verifiedRows,
    durationMs: Date.now() - start,
    headHash,
  };
}

/** Load audit_logs ordered by chain sequence and verify integrity. */
export async function verifyAuditLogIntegrity(
  pool: Pick<Pool, 'query'>,
): Promise<AuditIntegrityResult> {
  const start = Date.now();
  const result = await pool.query(`
    SELECT
      id,
      user_id,
      action,
      resource,
      details,
      ip_address::text AS ip_address,
      user_agent,
      created_at,
      prev_hash,
      row_hash
    FROM audit_logs
    ORDER BY created_at ASC, id ASC
  `);

  const chainResult = verifyAuditHashChain(
    result.rows.map((row) => mapDbRow(row as Record<string, unknown>)),
  );

  return {
    ...chainResult,
    durationMs: Date.now() - start,
  };
}
