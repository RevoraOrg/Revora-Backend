/**
 * @file auditMerkle.ts
 *
 * @notice Pure helpers for building a Merkle root over audit log row hashes.
 *
 * @dev Used by `AuditWitnessPublisher` to compute the Merkle root of a single
 *      day's audit rows before publishing to a public witness (issue #721).
 *      Leaves are the existing per-row `row_hash` values from the hash chain;
 *      the tree is binary, left-to-right, with odd nodes promoted unchanged.
 *      An empty day yields `null` (nothing to witness).
 */

import { createHash } from 'crypto';

/** Hash two sibling nodes into their parent. */
export function hashPair(left: string, right: string): string {
  return createHash('sha256').update(`${left}|${right}`).digest('hex');
}

/**
 * Compute the Merkle root of an ordered list of leaf hashes.
 *
 * @param leaves Ordered leaf hashes (typically audit `row_hash` values for a day).
 * @returns The root hash, or `null` when `leaves` is empty.
 */
export function computeMerkleRoot(leaves: string[]): string | null {
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0];

  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(hashPair(level[i], level[i + 1]));
      } else {
        // Odd leaf: promote unchanged so the tree stays deterministic.
        next.push(level[i]);
      }
    }
    level = next;
  }
  return level[0];
}

/**
 * UTC calendar day bounds `[start, end)` for `day`.
 */
export function utcDayBounds(day: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
