/**
 * Storage-layout drift report service.
 *
 * Generates dry-run diff reports for Soroban contract upgrades, flags
 * storage incompatibilities, and emits structured alerts on breaking diffs.
 *
 * This service is stateless — it does not persist reports. Callers may
 * persist the returned {@link DriftReport} in the audit log or other
 * storage as needed.
 *
 * @module services/storageDriftReportService
 */

import { globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import {
  StorageDescriptor,
  parseStorageDescriptor,
  buildDriftReport,
  DriftReport,
} from '../lib/storageLayoutDescriptor';

const logger = globalLogger.child({ service: 'storage-drift-report' });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GenerateReportInput {
  /** Raw ABI descriptor for the currently deployed code-id. */
  currentDescriptor: unknown;
  /** Raw ABI descriptor for the proposed target code-id. */
  targetDescriptor: unknown;
  /** Optional upgrade ID for audit-log correlation. */
  upgradeId?: string;
}

export interface ReportResult {
  report: DriftReport;
  alertEmitted: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Pure comparator + alert emitter.  No database dependency — the caller
 * is responsible for persisting the report in the audit log if needed.
 */
export class StorageDriftReportService {
  /**
   * Generate a storage-layout drift report from two raw ABI descriptors.
   *
   * Validates both descriptors, computes the diff, classifies the
   * severity, and emits a structured alert when breaking changes are
   * detected.
   *
   * @throws If either descriptor fails Zod validation.
   */
  async generateReport(input: GenerateReportInput): Promise<ReportResult> {
    const current = parseStorageDescriptor(input.currentDescriptor);
    const target = parseStorageDescriptor(input.targetDescriptor);

    const report = buildDriftReport(current, target);

    let alertEmitted = false;

    if (report.hasBreakingChanges) {
      logger.error('STORAGE_LAYOUT_DRIFT_ALARM', {
        alarm: true,
        upgrade_id: input.upgradeId ?? null,
        current_code_id: report.currentCodeId,
        target_code_id: report.targetCodeId,
        breaking_changes: report.breakingChanges,
        recommendation: report.recommendation,
      });

      alertEmitted = true;
    }

    if (report.diff.added.length > 0) {
      logger.warn('Storage layout entries added in target', {
        upgrade_id: input.upgradeId ?? null,
        added_keys: report.diff.added.map((a) => a.entry.key),
        recommendation: report.recommendation,
      });
    }

    if (
      report.recommendation === 'safe' &&
      !report.hasBreakingChanges &&
      report.diff.added.length === 0
    ) {
      logger.info('Storage layout drift: no changes detected', {
        upgrade_id: input.upgradeId ?? null,
        current_code_id: report.currentCodeId,
        target_code_id: report.targetCodeId,
      });
    }

    return { report, alertEmitted };
  }
}

// ── Convenience: validate a single descriptor ────────────────────────────────

/**
 * Validate a raw object as a storage descriptor without generating a report.
 * Useful for pre-flight validation on upload.
 *
 * @throws If the descriptor is invalid.
 */
export function validateDescriptor(raw: unknown): StorageDescriptor {
  return parseStorageDescriptor(raw);
}
