import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { AuditPurgeService } from './auditPurgeService';
import { MetricsCollector } from '../lib/metrics';
import { env } from '../config/env';

describe('AuditPurgeService legal-hold skip', () => {
  it('skips held periods, emits purge.skipped_hold, and only purges after release on a later cycle', async () => {
    const auditLogRepo = {
      purgeBefore: jest
        .fn()
        // Cycle 1: hold active → skip rows, delete none
        .mockResolvedValueOnce({ deletedCount: 0, skippedHoldCount: 3 })
        // Cycle 2 (after release): rows re-enter purge
        .mockResolvedValueOnce({ deletedCount: 3, skippedHoldCount: 0 }),
    } as unknown as AuditLogRepository;

    const metrics = new MetricsCollector({ enabled: true });
    const service = new AuditPurgeService(auditLogRepo, metrics);
    env.AUDIT_RETENTION_DAYS = 90;

    const first = await service.runPurge();
    expect(first).toEqual({ deletedCount: 0, skippedHoldCount: 3 });

    const second = await service.runPurge();
    expect(second).toEqual({ deletedCount: 3, skippedHoldCount: 0 });

    expect(auditLogRepo.purgeBefore).toHaveBeenCalledTimes(2);

    const snapshot = await metrics.getSnapshot();
    const skipped = snapshot.custom.find((m) => m.name === 'purge_skipped_hold');
    expect(skipped?.value).toBe(3);

    const purged = snapshot.custom.find(
      (m) => m.name === 'audit_logs_purged_total' && m.labels?.status === 'success',
    );
    expect(purged?.value).toBe(3);
  });
});

describe('AuditLogRepository.purgeBefore SQL contract', () => {
  it('counts skipped holds and deletes only non-held expired rows', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rowCount: 5 });

    const repo = new AuditLogRepository({ query } as any);
    const cutoff = new Date('2020-01-01T00:00:00.000Z');
    const result = await repo.purgeBefore(cutoff);

    expect(result).toEqual({ deletedCount: 5, skippedHoldCount: 2 });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('retention_labels'),
      [cutoff],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('DELETE FROM audit_logs'),
      [cutoff],
    );
    expect(String(query.mock.calls[1][0])).toContain('legal_hold = TRUE');
  });
});
