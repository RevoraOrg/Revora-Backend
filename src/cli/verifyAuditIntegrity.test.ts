import { runVerifyAuditIntegrityCli } from './verifyAuditIntegrity';
import * as auditHashChain from '../security/auditHashChain';

describe('verifyAuditIntegrity CLI', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    jest.restoreAllMocks();
  });

  it('exits with code 1 when DATABASE_URL is missing', async () => {
    delete process.env.DATABASE_URL;
    const code = await runVerifyAuditIntegrityCli();
    expect(code).toBe(1);
  });

  it('exits with code 0 when verification passes', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';

    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockResolvedValue({
      valid: true,
      totalRows: 2,
      verifiedRows: 2,
      durationMs: 5,
      headHash: 'deadbeef',
    });

    const { Pool } = require('pg');
    const end = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(Pool.prototype, 'end').mockImplementation(end);

    const code = await runVerifyAuditIntegrityCli();
    expect(code).toBe(0);
    expect(end).toHaveBeenCalled();
  });

  it('exits with code 1 when verification detects tampering', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';

    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockResolvedValue({
      valid: false,
      totalRows: 2,
      verifiedRows: 1,
      durationMs: 5,
      headHash: null,
      failure: {
        type: 'gap_detected',
        rowId: 'row-2',
        index: 1,
        message: 'Chain gap',
      },
    });

    jest.spyOn(require('pg').Pool.prototype, 'end').mockResolvedValue(undefined);

    const code = await runVerifyAuditIntegrityCli();
    expect(code).toBe(1);
  });

  it('exits with code 1 on unexpected runtime errors', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/test';

    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockRejectedValue(new Error('connection reset'));
    jest.spyOn(require('pg').Pool.prototype, 'end').mockResolvedValue(undefined);

    const code = await runVerifyAuditIntegrityCli();
    expect(code).toBe(1);
  });
});
