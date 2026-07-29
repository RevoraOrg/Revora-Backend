import { parseMappingTable, validateMappings, KNOWN_ALERTS, AlertEntry, ValidationResult } from './validate-alert-mappings';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeMappingMd(rows: string[]): string {
  return [
    '# Header',
    '',
    '| Alert Name | Description | Runbook | Owner | First Response |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Some trailing text.',
  ].join('\n');
}

describe('parseMappingTable', () => {
  it('extracts alert names from pipe table rows', () => {
    const content = makeMappingMd([
      '| `HighErrorRate` | desc | rb | o | a |',
      '| `payout_drift_alarm` | desc | rb | o | a |',
    ]);
    const tmp = join(tmpdir(), `alert-test-${Date.now()}.md`);
    writeFileSync(tmp, content, 'utf-8');
    const mapped = parseMappingTable(tmp);
    expect(mapped.has('HighErrorRate')).toBe(true);
    expect(mapped.has('payout_drift_alarm')).toBe(true);
    expect(mapped.has('NonExistent')).toBe(false);
  });

  it('returns empty set when no pipe table exists', () => {
    const content = '# Just prose\n\nNo table.\n';
    const tmp = join(tmpdir(), `alert-test-${Date.now()}.md`);
    writeFileSync(tmp, content, 'utf-8');
    expect(parseMappingTable(tmp).size).toBe(0);
  });

  it('reads the actual mapping file and finds expected alerts', () => {
    const mapped = parseMappingTable('docs/runbooks/README.md');
    expect(mapped.size).toBeGreaterThan(10);
    expect(mapped.has('HighErrorRate')).toBe(true);
    expect(mapped.has('payout_drift_alarm')).toBe(true);
    expect(mapped.has('OutboxSaturationCritical')).toBe(true);
  });
});

describe('validateMappings', () => {
  const known: AlertEntry[] = [
    { name: 'HighErrorRate', source: 'docs/METRICS_NEXT_STEPS.md' },
    { name: 'payout_drift_alarm', source: 'src/services/payoutDriftDetector.ts' },
    { name: 'NewAlert', source: 'src/services/newService.ts' },
  ];

  it('passes when all known alerts are mapped', () => {
    const mapped = new Set(['HighErrorRate', 'payout_drift_alarm', 'NewAlert']);
    const result = validateMappings(known, mapped);
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it('fails when a known alert is not in the mapping table', () => {
    const mapped = new Set(['HighErrorRate']);
    const result = validateMappings(known, mapped);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(2);
    expect(result.missing.map((a) => a.name)).toContain('payout_drift_alarm');
    expect(result.missing.map((a) => a.name)).toContain('NewAlert');
  });
});

describe('Full CI validation against actual files', () => {
  it('run() exits 0 when mapping is complete', () => {
    const { run } = require('./validate-alert-mappings');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try { run(); } catch (e: any) {
      if (e.message !== 'exit') throw e;
    }

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('OK'));
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('run() exits 1 when an alert is removed from mapping', () => {
    const { run, KNOWN_ALERTS } = require('./validate-alert-mappings');
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const orig = KNOWN_ALERTS.slice();
    try {
      KNOWN_ALERTS.push({ name: 'AlertNotInDocs', source: 'test' });
      run();
    } catch (e: any) {
      if (e.message !== 'exit') throw e;
    } finally {
      KNOWN_ALERTS.length = 0;
      KNOWN_ALERTS.push(...orig);
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('AlertNotInDocs'));
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('all KNOWN_ALERTS have a corresponding mapping in the README', () => {
    const mapped = parseMappingTable('docs/runbooks/README.md');
    const result = validateMappings(KNOWN_ALERTS, mapped);
    if (!result.ok) {
      const names = result.missing.map((a: AlertEntry) => a.name).join(', ');
      throw new Error(`Missing mappings: ${names}`);
    }
  });
});
