import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');

/**
 * Curated list of every operational alert that the system can fire.
 * Each entry records where the alert is defined so CI can point to the source.
 *
 * When you add a new alert, add it here AND add a row to the mapping
 * table in docs/runbooks/README.md.
 */
export const KNOWN_ALERTS: AlertEntry[] = [
  { name: 'HighErrorRate', source: 'docs/METRICS_NEXT_STEPS.md' },
  { name: 'HighLatency', source: 'docs/METRICS_NEXT_STEPS.md' },
  { name: 'DatabasePoolExhausted', source: 'docs/METRICS_NEXT_STEPS.md' },
  { name: 'MemoryUsageHigh', source: 'docs/METRICS_NEXT_STEPS.md' },
  { name: 'OutboxSaturationCritical', source: 'docs/outbox-lag-saturation-alerts.md' },
  { name: 'outbox_saturation_alerts', source: 'src/services/outboxDispatcher.ts' },
  { name: 'payout_drift_alarm', source: 'src/services/payoutDriftDetector.ts' },
  { name: 'payout_drift_missing_total', source: 'src/services/payoutDriftDetector.ts' },
  { name: 'payout_drift_underfunded_total', source: 'src/services/payoutDriftDetector.ts' },
  { name: 'payout_drift_overfunded_total', source: 'src/services/payoutDriftDetector.ts' },
  { name: 'payout_drift_duplicate_tx_total', source: 'src/services/payoutDriftDetector.ts' },
  { name: 'oidc_discovery_changed', source: 'docs/oidc-discovery-digest-alert.md' },
  { name: 'fx_provider_health_score', source: 'src/services/providerHealthScorer.ts' },
  { name: 'provider_demoted', source: 'docs/fx-provider-health-scoring.md' },
  { name: 'provider_degraded', source: 'docs/fx-provider-health-scoring.md' },
  { name: 'MultiRegionFailover', source: 'docs/runbooks/multi-region-failover.md' },
  { name: 'contract_upgrade_auto_rollback', source: 'docs/contract-upgrade-auto-rollback.md' },
  { name: 'migration_failed', source: 'src/db/migrations/safety/monitoring.ts' },
  { name: 'migration_rolled_back', source: 'src/db/migrations/safety/monitoring.ts' },
  { name: 'email_alarm_alignment_failure', source: 'src/services/emailDeliverabilityService.ts' },
  { name: 'email_alarm_high_bounce_ratio', source: 'src/services/emailDeliverabilityService.ts' },
  { name: 'CertPinningMismatch', source: 'docs/runbooks/mobile-cert-pinning.md' },
  { name: 'DbPoolWaitersHigh', source: 'docs/autoscaling-db-pool-signal.md' },
  { name: 'DbPoolUtilizationHigh', source: 'docs/autoscaling-db-pool-signal.md' },
];

export interface AlertEntry {
  name: string;
  source: string;
}

export interface ValidationResult {
  missing: AlertEntry[];
  ok: boolean;
}

/**
 * Parse the mapping table in docs/runbooks/README.md.
 * Extracts all alert names from the first pipe-delimited table.
 */
export function parseMappingTable(filePath: string): Set<string> {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const mapped = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('| `')) {
      const match = line.match(/^\|\s*`([^`]+)`/);
      if (match) mapped.add(match[1]);
    }
  }

  return mapped;
}

/**
 * Validate that every known alert has a row in the mapping table.
 */
export function validateMappings(
  knownAlerts: AlertEntry[],
  mappedAlerts: Set<string>,
): ValidationResult {
  const missing: AlertEntry[] = [];

  for (const entry of knownAlerts) {
    if (!mappedAlerts.has(entry.name)) {
      missing.push(entry);
    }
  }

  return { missing, ok: missing.length === 0 };
}

export function run(): void {
  const mappingPath = resolve(ROOT, 'docs/runbooks/README.md');
  const mappedAlerts = parseMappingTable(mappingPath);
  const result = validateMappings(KNOWN_ALERTS, mappedAlerts);

  if (result.missing.length > 0) {
    console.error('ERROR: The following alerts are defined but missing from docs/runbooks/README.md:');
    for (const alert of result.missing) {
      console.error(`  - ${alert.name} (defined in ${alert.source})`);
    }
    console.error();
    console.error('Add a row for each alert to the mapping table in docs/runbooks/README.md');
    process.exit(1);
  }

  console.log(`OK: All ${KNOWN_ALERTS.length} known alerts have mapping entries.`);
  process.exit(0);
}

if (require.main === module) {
  run();
}
