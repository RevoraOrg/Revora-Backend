import { createHash, createHmac } from 'crypto';
import { Pool, PoolClient } from 'pg';
import {
  LedgerPeriodLock,
  LedgerPeriodLockRepository,
} from '../db/repositories/ledgerPeriodLockRepository';
import { AppError } from '../lib/errors';
import { withTransaction } from '../db/transaction';
import {
  JournalEntryExport,
  LedgerService,
  MaterializedExport,
} from './ledgerService';

jest.mock('../db/transaction', () => ({
  withTransaction: jest.fn(),
}));

describe('LedgerService period-close dual control', () => {
  const offeringId = 'offering-1';
  const periodId = '2024-01';
  const initiatorId = 'actor-1';
  const confirmerId = 'actor-2';
  const signingKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  const entry: JournalEntryExport = {
    id: 'entry-1',
    offering_id: offeringId,
    period_id: periodId,
    amount: '125.50',
    issuer_id: 'issuer-1',
    reported_at: '2024-01-15T12:00:00.000Z',
    created_at: '2024-01-15T13:00:00.000Z',
  };

  let originalSigningKey: string | undefined;
  let originalSigningKeyVersion: string | undefined;
  let pool: Pool;
  let lockRepo: {
    getLock: jest.Mock;
    initiatePeriodClose: jest.Mock;
    getInitiatedLock: jest.Mock;
    confirmPeriodClose: jest.Mock;
    getLockedExportMetadata: jest.Mock;
  };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: LedgerService;

  const makeLock = (
    overrides: Partial<LedgerPeriodLock> = {},
  ): LedgerPeriodLock => ({
    id: 'lock-1',
    period_id: periodId,
    offering_id: offeringId,
    status: 'initiated',
    initiated_by: initiatorId,
    initiated_at: new Date('2024-01-31T12:00:00.000Z'),
    confirmed_by: null,
    confirmed_at: null,
    locked_at: null,
    export_format: 'jsonl',
    export_reference: null,
    export_hash: null,
    export_signature: null,
    signing_algorithm: 'hmac-sha256-v1',
    signing_key_version: 1,
    entry_count: null,
    created_at: new Date('2024-01-31T12:00:00.000Z'),
    updated_at: new Date('2024-01-31T12:00:00.000Z'),
    ...overrides,
  });

  beforeAll(() => {
    originalSigningKey = process.env.LEDGER_CLOSE_SIGNING_KEY;
    originalSigningKeyVersion = process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LEDGER_CLOSE_SIGNING_KEY = signingKey;
    process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = '1';

    pool = {} as Pool;
    client = {
      query: jest.fn().mockImplementation((query: string) => {
        if (query.includes('pg_advisory_xact_lock')) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({
          rows: [
            {
              id: entry.id,
              offering_id: entry.offering_id,
              period_id: entry.period_id,
              amount: entry.amount,
              issuer_id: entry.issuer_id,
              reported_at: new Date(entry.reported_at),
              created_at: new Date(entry.created_at),
            },
          ],
        });
      }),
      release: jest.fn(),
    };
    lockRepo = {
      getLock: jest.fn(),
      initiatePeriodClose: jest.fn(),
      getInitiatedLock: jest.fn(),
      confirmPeriodClose: jest.fn(),
      getLockedExportMetadata: jest.fn(),
    };
    service = new LedgerService(
      pool,
      lockRepo as unknown as LedgerPeriodLockRepository,
    );

    jest.mocked(withTransaction).mockImplementation(
      async (_pool, callback) =>
        callback(client as unknown as PoolClient),
    );
  });

  afterAll(() => {
    if (originalSigningKey === undefined) {
      delete process.env.LEDGER_CLOSE_SIGNING_KEY;
    } else {
      process.env.LEDGER_CLOSE_SIGNING_KEY = originalSigningKey;
    }

    if (originalSigningKeyVersion === undefined) {
      delete process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;
    } else {
      process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = originalSigningKeyVersion;
    }
  });

  it('creates an initiated lock for a new period', async () => {
    lockRepo.getLock.mockResolvedValue(null);
    lockRepo.initiatePeriodClose.mockResolvedValue(makeLock());

    const result = await service.initiatePeriodClose(
      offeringId,
      periodId,
      initiatorId,
    );

    expect(lockRepo.initiatePeriodClose).toHaveBeenCalledWith({
      period_id: periodId,
      offering_id: offeringId,
      initiated_by: initiatorId,
      export_format: 'jsonl',
    });
    expect(result).toMatchObject({
      lock_id: 'lock-1',
      period_id: periodId,
      offering_id: offeringId,
      status: 'initiated',
      initiated_by: initiatorId,
      initiated_at: '2024-01-31T12:00:00.000Z',
    });
  });

  it('rejects initiation when the period is already locked', async () => {
    lockRepo.getLock.mockResolvedValue(makeLock({ status: 'locked' }));

    await expect(
      service.initiatePeriodClose(offeringId, periodId, initiatorId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: expect.stringContaining('already locked'),
    });
    expect(lockRepo.initiatePeriodClose).not.toHaveBeenCalled();
  });

  it('rejects confirmation by the actor who initiated the close', async () => {
    lockRepo.getInitiatedLock.mockResolvedValue(makeLock());

    await expect(
      service.confirmPeriodClose(offeringId, periodId, initiatorId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      message: expect.stringContaining('different actor'),
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('allows a different actor to confirm the close', async () => {
    const lockedAt = new Date('2024-02-01T00:00:00.000Z');
    lockRepo.getInitiatedLock.mockResolvedValue(makeLock());
    lockRepo.confirmPeriodClose.mockImplementation(
      async (_lockId, input) =>
        makeLock({
          status: 'locked',
          confirmed_by: input.confirmed_by,
          confirmed_at: lockedAt,
          locked_at: lockedAt,
          export_hash: input.export_hash,
          export_signature: input.export_signature,
          signing_algorithm: input.signing_algorithm,
          entry_count: input.entry_count,
        }),
    );

    const result = await service.confirmPeriodClose(
      offeringId,
      periodId,
      confirmerId,
    );

    expect(lockRepo.confirmPeriodClose).toHaveBeenCalledWith(
      'lock-1',
      expect.objectContaining({ confirmed_by: confirmerId }),
      client,
    );
    expect(result).toMatchObject({
      lock_id: 'lock-1',
      status: 'locked',
      initiated_by: initiatorId,
      confirmed_by: confirmerId,
      locked_at: lockedAt.toISOString(),
      entry_count: 1,
    });
  });

  it('produces a deterministic export hash and HMAC signature for fixed entries', async () => {
    lockRepo.getInitiatedLock.mockResolvedValue(makeLock());
    lockRepo.confirmPeriodClose.mockImplementation(
      async (_lockId, input) =>
        makeLock({
          status: 'locked',
          confirmed_by: confirmerId,
          locked_at: new Date('2024-02-01T00:00:00.000Z'),
          export_hash: input.export_hash,
          export_signature: input.export_signature,
          signing_algorithm: input.signing_algorithm,
          entry_count: input.entry_count,
        }),
    );

    const result = await service.confirmPeriodClose(
      offeringId,
      periodId,
      confirmerId,
    );
    const canonicalJsonl = JSON.stringify(entry);
    const expectedHash = createHash('sha256')
      .update(canonicalJsonl)
      .digest('hex');
    const expectedSignature = createHmac(
      'sha256',
      Buffer.from(signingKey, 'hex'),
    )
      .update(expectedHash)
      .digest('hex');

    expect(result.export_hash).toBe(expectedHash);
    expect(result.export_signature).toBe(expectedSignature);
    expect(result.signing_algorithm).toBe('hmac-sha256-v1');

    const exportValue: MaterializedExport = {
      format: 'jsonl',
      entries: [entry],
      period_id: periodId,
      offering_id: offeringId,
      entry_count: 1,
      exported_at: '2024-02-01T00:00:00.000Z',
    };
    const internals = service as unknown as {
      computeExportHash: (value: MaterializedExport) => string;
      signExportHash: (hash: string) => string;
    };
    expect(internals.computeExportHash(exportValue)).toBe(expectedHash);
    expect(internals.signExportHash(expectedHash)).toBe(expectedSignature);
  });

  it('returns not found when no initiated close exists', async () => {
    lockRepo.getInitiatedLock.mockResolvedValue(null);

    await expect(
      service.confirmPeriodClose(offeringId, periodId, confirmerId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: expect.stringContaining('No initiated close found'),
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
