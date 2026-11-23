import { createHmac } from 'crypto';
import { Pool } from 'pg';
import { LedgerPeriodLockRepository } from '../db/repositories/ledgerPeriodLockRepository';
import { LedgerService } from './ledgerService';

describe('LedgerService signing configuration', () => {
  const validKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
  let originalSigningKey: string | undefined;
  let originalSigningKeyVersion: string | undefined;
  let pool: Pool;
  let lockRepo: LedgerPeriodLockRepository;

  beforeAll(() => {
    originalSigningKey = process.env.LEDGER_CLOSE_SIGNING_KEY;
    originalSigningKeyVersion = process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;
  });

  beforeEach(() => {
    process.env.LEDGER_CLOSE_SIGNING_KEY = validKey;
    process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = '1';
    pool = {} as Pool;
    lockRepo = {} as LedgerPeriodLockRepository;
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

  const createService = () => new LedgerService(pool, lockRepo);

  it('rejects a missing signing key', () => {
    delete process.env.LEDGER_CLOSE_SIGNING_KEY;

    expect(createService).toThrow(
      'LEDGER_CLOSE_SIGNING_KEY environment variable not set',
    );
  });

  it('rejects a hexadecimal signing key shorter than 32 bytes', () => {
    process.env.LEDGER_CLOSE_SIGNING_KEY = 'ab'.repeat(31);

    expect(createService).toThrow(
      'LEDGER_CLOSE_SIGNING_KEY must be a hexadecimal string of at least 32 bytes',
    );
  });

  it('rejects a signing key containing non-hexadecimal characters', () => {
    process.env.LEDGER_CLOSE_SIGNING_KEY = `${'a'.repeat(63)}g`;

    expect(createService).toThrow(
      'LEDGER_CLOSE_SIGNING_KEY must be a hexadecimal string of at least 32 bytes',
    );
  });

  it('accepts a valid key and produces a reproducible signature', () => {
    const service = createService();
    const hash = 'a'.repeat(64);
    const expectedSignature = createHmac('sha256', Buffer.from(validKey, 'hex'))
      .update(hash)
      .digest('hex');

    expect(service.verifyExportSignature(hash, expectedSignature)).toBe(true);
  });

  it('accepts and stores a positive integer version', () => {
    process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = '7';

    const service = createService() as unknown as {
      signingKey: { version: number };
    };

    expect(service.signingKey.version).toBe(7);
  });

  it.each(['abc', '1abc', '1.5', '0', '-1', '9007199254740992'])(
    'rejects invalid signing key version %s',
    (version) => {
      process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = version;

      expect(createService).toThrow(
        'LEDGER_CLOSE_SIGNING_KEY_VERSION must be a positive integer',
      );
    },
  );

  it('defaults an unset signing key version to 1', () => {
    delete process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;

    const service = createService() as unknown as {
      signingKey: { version: number };
    };

    expect(service.signingKey.version).toBe(1);
  });
});
