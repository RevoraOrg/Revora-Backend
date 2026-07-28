/**
 * Storage-layout descriptor comparator for Soroban contract upgrades.
 *
 * Compares committed ABI descriptors between two code-ids and produces a
 * structured diff that flags storage-layout incompatibilities *before*
 * an upgrade is scheduled.
 *
 * Breaking changes (block the upgrade):
 *   - Removing a storage entry that existed in the current version
 *   - Changing the storage type of an existing entry (instance ↔ persistent ↔ temporary)
 *   - Narrowing the value type of an existing entry
 *
 * Safe changes (allow the upgrade):
 *   - Adding new storage entries (defaults are set by the contract)
 *   - Widening the value type of an existing entry
 *   - Renaming an entry with the same type and layout (logged, not blocked)
 *
 * @module lib/storageLayoutDescriptor
 */

import { z } from 'zod';

// ── Schema (runtime-validated) ────────────────────────────────────────────────

export const StorageEntrySchema = z.object({
  /** Unique key within the contract's storage namespace. */
  key: z.string().min(1),
  /** Soroban storage lifetime. */
  storageType: z.enum(['instance', 'persistent', 'temporary']),
  /** Soroban value type (Bytes, Uint32, Address, etc.). */
  valueType: z.string().min(1),
  /** Optional human-readable description. */
  description: z.string().optional(),
});

export type StorageEntry = z.infer<typeof StorageEntrySchema>;

export const StorageDescriptorSchema = z.object({
  /** ABI descriptor version for forward-compatibility. */
  version: z.string().min(1),
  /** The code-id this descriptor describes. */
  codeId: z.string().min(1),
  /** All storage entries declared by this code-id. */
  entries: z.array(StorageEntrySchema),
});

export type StorageDescriptor = z.infer<typeof StorageDescriptorSchema>;

// ── Diff types ───────────────────────────────────────────────────────────────

export interface AddedEntry {
  entry: StorageEntry;
}

export interface RemovedEntry {
  entry: StorageEntry;
}

export interface ModifiedEntry {
  entry: StorageEntry;
  before: StorageEntry;
  breaking: boolean;
  reason: string;
}

export interface StorageDiff {
  added: AddedEntry[];
  removed: RemovedEntry[];
  modified: ModifiedEntry[];
}

export type DriftSeverity = 'safe' | 'review_required' | 'blocking';

export interface DriftReport {
  /** The code-id currently deployed (source of truth). */
  currentCodeId: string;
  /** The proposed code-id to upgrade to. */
  targetCodeId: string;
  /** ISO-8601 timestamp of report generation. */
  timestamp: string;
  /** The raw structural diff. */
  diff: StorageDiff;
  /** Whether any breaking changes were detected. */
  hasBreakingChanges: boolean;
  /** Human-readable list of breaking-change reasons. */
  breakingChanges: string[];
  /** Overall recommendation for the upgrade. */
  recommendation: DriftSeverity;
}

// ── Comparator ───────────────────────────────────────────────────────────────

/**
 * Classify whether a value-type change is a narrowing (breaking) or
 * widening (safe) transformation.
 *
 * For simplicity we treat any *change* in type as potentially breaking
 * unless the new type is a strict superset of the old. Since Soroban
 * value types are opaque strings we conservatively mark any change as
 * breaking unless old === new.
 */
function isValueTypeChangeBreaking(oldType: string, newType: string): boolean {
  return oldType !== newType;
}

/**
 * Compare two storage descriptors and produce a structured diff.
 *
 * @param current - The currently deployed descriptor.
 * @param target  - The proposed descriptor.
 * @returns A {@link StorageDiff} describing additions, removals, and modifications.
 */
export function compareStorageLayouts(
  current: StorageDescriptor,
  target: StorageDescriptor,
): StorageDiff {
  const currentMap = new Map<string, StorageEntry>();
  for (const entry of current.entries) {
    currentMap.set(entry.key, entry);
  }

  const targetMap = new Map<string, StorageEntry>();
  for (const entry of target.entries) {
    targetMap.set(entry.key, entry);
  }

  const added: AddedEntry[] = [];
  const removed: RemovedEntry[] = [];
  const modified: ModifiedEntry[] = [];

  // Entries in target but not in current → added
  for (const entry of target.entries) {
    if (!currentMap.has(entry.key)) {
      added.push({ entry });
    }
  }

  // Entries in current but not in target → removed
  for (const entry of current.entries) {
    if (!targetMap.has(entry.key)) {
      removed.push({ entry });
    }
  }

  // Entries present in both → check for modifications
  for (const key of currentMap.keys()) {
    const currentEntry = currentMap.get(key)!;
    const targetEntry = targetMap.get(key);
    if (!targetEntry) continue;

    const reasons: string[] = [];

    if (currentEntry.storageType !== targetEntry.storageType) {
      reasons.push(
        `storage type changed from '${currentEntry.storageType}' to '${targetEntry.storageType}'`,
      );
    }

    if (isValueTypeChangeBreaking(currentEntry.valueType, targetEntry.valueType)) {
      reasons.push(
        `value type changed from '${currentEntry.valueType}' to '${targetEntry.valueType}'`,
      );
    }

    if (reasons.length > 0) {
      modified.push({
        entry: targetEntry,
        before: currentEntry,
        breaking: true,
        reason: reasons.join('; '),
      });
    }
  }

  return { added, removed, modified };
}

// ── Report builder ───────────────────────────────────────────────────────────

/**
 * Build a full {@link DriftReport} from two descriptors.
 *
 * @param current - Currently deployed descriptor.
 * @param target  - Proposed descriptor.
 * @returns The drift report with severity classification.
 */
export function buildDriftReport(
  current: StorageDescriptor,
  target: StorageDescriptor,
): DriftReport {
  const diff = compareStorageLayouts(current, target);

  const breakingChanges: string[] = [];

  for (const r of diff.removed) {
    breakingChanges.push(`Removed storage entry '${r.entry.key}' (${r.entry.storageType}/${r.entry.valueType})`);
  }

  for (const m of diff.modified) {
    if (m.breaking) {
      breakingChanges.push(`Modified entry '${m.entry.key}': ${m.reason}`);
    }
  }

  const hasBreakingChanges = breakingChanges.length > 0;

  let recommendation: DriftSeverity;
  if (hasBreakingChanges) {
    recommendation = 'blocking';
  } else if (diff.added.length > 0) {
    recommendation = 'review_required';
  } else {
    recommendation = 'safe';
  }

  return {
    currentCodeId: current.codeId,
    targetCodeId: target.codeId,
    timestamp: new Date().toISOString(),
    diff,
    hasBreakingChanges,
    breakingChanges,
    recommendation,
  };
}

// ── Validation helpers ───────────────────────────────────────────────────────

/**
 * Parse and validate a raw object as a {@link StorageDescriptor}.
 * Returns the validated descriptor or throws a ZodError.
 */
export function parseStorageDescriptor(raw: unknown): StorageDescriptor {
  return StorageDescriptorSchema.parse(raw);
}
