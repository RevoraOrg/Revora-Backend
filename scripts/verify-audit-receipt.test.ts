import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import {
  AUDIT_LOG_GENESIS_HASH,
  AuditLogChainRow,
  computeAuditRowHash,
} from '../src/security/auditHashChain';
import {
  AuditReceipt,
  formatReport,
  loadContent,
  normalizeReceipt,
  parseCliArgs,
  parseLogExcerpt,
  printHelp,
  runCli,
  verifyAuditReceipt,
} from './verify-audit-receipt';

// Mock fs.promises.readFile for loadContent tests
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    promises: {
      ...actualFs.promises,
      readFile: jest.fn(),
    },
  };
});

describe('verify-audit-receipt script', () => {
  const makeRow = (
    overrides: Partial<AuditLogChainRow> & Pick<AuditLogChainRow, 'id' | 'action' | 'created_at'>,
    prevHash: string = AUDIT_LOG_GENESIS_HASH,
  ): AuditLogChainRow => {
    const base: Omit<AuditLogChainRow, 'row_hash'> = {
      id: overrides.id,
      user_id: overrides.user_id ?? null,
      action: overrides.action,
      resource: overrides.resource ?? null,
      details: overrides.details ?? null,
      ip_address: overrides.ip_address ?? null,
      user_agent: overrides.user_agent ?? null,
      created_at: overrides.created_at,
      prev_hash: overrides.prev_hash ?? prevHash,
    };
    return {
      ...base,
      row_hash: overrides.row_hash ?? computeAuditRowHash(base),
    };
  };

  const createTestChain = (): AuditLogChainRow[] => {
    const r1 = makeRow({
      id: '00000000-0000-4000-8000-000000000001',
      action: 'login',
      created_at: new Date('2026-01-15T10:00:00.000Z'),
    });
    const r2 = makeRow(
      {
        id: '00000000-0000-4000-8000-000000000002',
        action: 'invest',
        created_at: new Date('2026-01-15T10:05:00.000Z'),
      },
      r1.row_hash,
    );
    const r3 = makeRow(
      {
        id: '00000000-0000-4000-8000-000000000003',
        action: 'logout',
        created_at: new Date('2026-01-15T10:10:00.000Z'),
      },
      r2.row_hash,
    );
    return [r1, r2, r3];
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('normalizeReceipt', () => {
    it('normalizes alias fields for receipt parameters', () => {
      const raw: AuditReceipt = {
        prev_hash: 'start123',
        head_hash: 'head456',
        count: 5,
      };
      const normalized = normalizeReceipt(raw);
      expect(normalized.start_prev_hash).toBe('start123');
      expect(normalized.expected_head_hash).toBe('head456');
      expect(normalized.total_rows).toBe(5);
    });

    it('supports alternative alias field names: initial_prev_hash, final_hash, row_count', () => {
      const raw: AuditReceipt = {
        initial_prev_hash: 'init123',
        final_hash: 'final456',
        row_count: 10,
      };
      const normalized = normalizeReceipt(raw);
      expect(normalized.start_prev_hash).toBe('init123');
      expect(normalized.expected_head_hash).toBe('final456');
      expect(normalized.total_rows).toBe(10);
    });

    it('supports alternative alias field names: final_row_hash and row_hash', () => {
      const raw1: AuditReceipt = { final_row_hash: 'frh' };
      const raw2: AuditReceipt = { row_hash: 'rh' };
      expect(normalizeReceipt(raw1).expected_head_hash).toBe('frh');
      expect(normalizeReceipt(raw2).expected_head_hash).toBe('rh');
    });
  });

  describe('parseLogExcerpt', () => {
    it('returns empty array for empty or whitespace content', () => {
      expect(parseLogExcerpt('')).toEqual([]);
      expect(parseLogExcerpt('   \n  ')).toEqual([]);
    });

    it('parses JSON array', () => {
      const rows = createTestChain();
      const content = JSON.stringify(rows);
      const parsed = parseLogExcerpt(content);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].id).toBe(rows[0].id);
      expect(parsed[0].created_at).toBeInstanceOf(Date);
    });

    it('parses newline-delimited JSON (JSONL)', () => {
      const rows = createTestChain();
      const content = rows.map((r) => JSON.stringify(r)).join('\n');
      const parsed = parseLogExcerpt(content);
      expect(parsed).toHaveLength(3);
      expect(parsed[1].action).toBe('invest');
    });

    it('handles numeric epoch timestamps and null fields', () => {
      const raw = [
        {
          id: 'row-x',
          action: 'test',
          created_at: 1768471200000,
          user_id: null,
        },
      ];
      const parsed = parseLogExcerpt(JSON.stringify(raw));
      expect(parsed[0].created_at.getTime()).toBe(1768471200000);
      expect(parsed[0].user_id).toBeNull();
    });

    it('parses raw entries with non-null string fields', () => {
      const raw = [
        {
          id: 'row-full',
          user_id: 'usr_99',
          action: 'act_full',
          resource: 'res_99',
          details: 'det_99',
          ip_address: '1.2.3.4',
          user_agent: 'agent_99',
          created_at: '2026-01-15T10:00:00.000Z',
          prev_hash: 'ph',
          row_hash: 'rh',
        },
      ];
      const parsed = parseLogExcerpt(JSON.stringify(raw));
      expect(parsed[0].user_id).toBe('usr_99');
      expect(parsed[0].resource).toBe('res_99');
      expect(parsed[0].details).toBe('det_99');
      expect(parsed[0].ip_address).toBe('1.2.3.4');
      expect(parsed[0].user_agent).toBe('agent_99');
    });
  });

  describe('loadContent', () => {
    it('reads local file via fs.promises.readFile', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('file-data');
      const res = await loadContent('test.json');
      expect(res).toBe('file-data');
    });

    it('fetches content over HTTP', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event, cb) => {
          return mockReq;
        }),
      };
      const mockRes = {
        statusCode: 200,
        on: jest.fn().mockImplementation((event, cb) => {
          if (event === 'data') cb('http-data');
          if (event === 'end') cb();
        }),
      };

      jest.spyOn(http, 'get').mockImplementation((url, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const data = await loadContent('http://example.com/receipt.json');
      expect(data).toBe('http-data');
    });

    it('fetches content over HTTPS', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event, cb) => mockReq),
      };
      const mockRes = {
        statusCode: 200,
        on: jest.fn().mockImplementation((event, cb) => {
          if (event === 'data') cb('https-data');
          if (event === 'end') cb();
        }),
      };

      jest.spyOn(https, 'get').mockImplementation((url, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const data = await loadContent('https://example.com/receipt.json');
      expect(data).toBe('https-data');
    });

    it('rejects on HTTP error status', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event, cb) => mockReq),
      };
      const mockRes = {
        statusCode: 404,
      };

      jest.spyOn(http, 'get').mockImplementation((url, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      await expect(loadContent('http://example.com/404.json')).rejects.toThrow('HTTP 404');
    });

    it('rejects on HTTPS error status', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event, cb) => mockReq),
      };
      const mockRes = {
        statusCode: 404,
      };

      jest.spyOn(https, 'get').mockImplementation((url, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      await expect(loadContent('https://example.com/404.json')).rejects.toThrow('HTTP 404');
    });

    it('rejects on request network error', async () => {
      const mockReq = {
        on: jest.fn().mockImplementation((event, cb) => {
          if (event === 'error') cb(new Error('Connection refused'));
          return mockReq;
        }),
      };

      jest.spyOn(http, 'get').mockImplementation(() => mockReq as any);

      await expect(loadContent('http://example.com/error.json')).rejects.toThrow('Connection refused');
    });
  });

  describe('verifyAuditReceipt', () => {
    it('verifies a valid multi-row chain against matching receipt', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = {
        start_prev_hash: AUDIT_LOG_GENESIS_HASH,
        expected_head_hash: rows[2].row_hash,
        total_rows: 3,
        start_id: rows[0].id,
        end_id: rows[2].id,
      };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(true);
      expect(res.verifiedEntries).toBe(3);
      expect(res.computedHeadHash).toBe(rows[2].row_hash);
    });

    it('accepts an empty excerpt when receipt total_rows is 0', () => {
      const receipt: AuditReceipt = { total_rows: 0 };
      const res = verifyAuditReceipt(receipt, []);
      expect(res.valid).toBe(true);
      expect(res.totalEntries).toBe(0);
    });

    it('returns EMPTY_EXCERPT failure when excerpt is empty but total_rows > 0', () => {
      const receipt: AuditReceipt = { total_rows: 5 };
      const res = verifyAuditReceipt(receipt, []);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('EMPTY_EXCERPT');
      expect(res.actionableRecommendation).toMatch(/matching the receipt period/i);
    });

    it('returns TRUNCATED_EXCERPT with actionable error when excerpt has fewer rows than expected', () => {
      const rows = createTestChain().slice(0, 2); // 2 rows instead of 3
      const receipt: AuditReceipt = {
        total_rows: 3,
        start_id: '00000000-0000-4000-8000-000000000001',
        end_id: '00000000-0000-4000-8000-000000000003',
      };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('TRUNCATED_EXCERPT');
      expect(res.message).toContain('Log excerpt is truncated: received 2 entries, but receipt expected 3');
      expect(res.actionableRecommendation).toContain('Ensure the log export includes all 3 entries without truncation');
    });

    it('returns ROW_COUNT_MISMATCH when excerpt has more rows than expected', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = { total_rows: 2 };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('ROW_COUNT_MISMATCH');
    });

    it('returns START_ID_MISMATCH when first row ID does not match start_id', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = { start_id: 'different-id' };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('START_ID_MISMATCH');
    });

    it('returns END_ID_MISMATCH when last row ID does not match end_id', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = { end_id: 'different-id' };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('END_ID_MISMATCH');
    });

    it('returns START_HASH_MISMATCH when starting prev_hash does not match receipt', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = { start_prev_hash: 'a'.repeat(64) };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('START_HASH_MISMATCH');
    });

    it('returns MISSING_HASHES when a row is missing hash fields', () => {
      const rows = createTestChain();
      rows[1].row_hash = '';

      const receipt: AuditReceipt = {};
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('MISSING_HASHES');
    });

    it('returns BROKEN_CHAIN when genesis anchor is broken at row 0', () => {
      const rows = createTestChain();
      const brokenRow0Base = { ...rows[0], prev_hash: 'wrong_prev' };
      rows[0] = { ...brokenRow0Base, row_hash: computeAuditRowHash(brokenRow0Base) };

      const receipt: AuditReceipt = {};
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('BROKEN_CHAIN');
    });

    it('returns GAP_DETECTED when mid-chain prev_hash link is broken', () => {
      const rows = createTestChain();
      rows[2] = { ...rows[2], prev_hash: 'broken_link' };

      const receipt: AuditReceipt = {};
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('GAP_DETECTED');
      expect(res.message).toMatch(/gap or deleted entry/i);
    });

    it('returns HASH_MISMATCH when payload was tampered with', () => {
      const rows = createTestChain();
      rows[1] = { ...rows[1], action: 'tampered_action' };

      const receipt: AuditReceipt = {};
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('HASH_MISMATCH');
      expect(res.actionableRecommendation).toMatch(/integrity check failed/i);
    });

    it('returns HEAD_HASH_MISMATCH when computed head hash differs from receipt expected_head_hash', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = { expected_head_hash: 'f'.repeat(64) };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(false);
      expect(res.failureType).toBe('HEAD_HASH_MISMATCH');
    });
  });

  describe('formatReport', () => {
    it('formats human-readable report for passing verification', () => {
      const rows = createTestChain();
      const res = verifyAuditReceipt({ expected_head_hash: rows[2].row_hash }, rows);
      const output = formatReport(res, 'receipt.json', 'excerpt.json');

      expect(output).toContain('AUDIT LOG INTEGRITY VERIFICATION REPORT');
      expect(output).toContain('PASS [VALID INTEGRITY PROOF]');
      expect(output).toContain('VERIFICATION RESULT: SUCCESS');
    });

    it('formats human-readable report for failing verification', () => {
      const res = verifyAuditReceipt({ total_rows: 5 }, []);
      const output = formatReport(res, 'receipt.json', 'excerpt.json');

      expect(output).toContain('FAIL [TAMPER OR INVALID PROOF]');
      expect(output).toContain('VERIFICATION RESULT: FAILURE [EMPTY_EXCERPT]');
      expect(output).toContain('Action Required:');
    });

    it('suppresses derivation trace when quiet option is true', () => {
      const rows = createTestChain();
      const res = verifyAuditReceipt({ expected_head_hash: rows[2].row_hash }, rows);
      const output = formatReport(res, undefined, undefined, true);

      expect(output).not.toContain('DERIVATION TRACE:');
    });
  });

  describe('parseCliArgs and printHelp', () => {
    it('parses flag options', () => {
      const opts = parseCliArgs([
        '--receipt',
        'r.json',
        '--entries',
        'e.json',
        '--json',
        '--quiet',
      ]);
      expect(opts.receiptPathOrUrl).toBe('r.json');
      expect(opts.excerptPathOrUrl).toBe('e.json');
      expect(opts.jsonOutput).toBe(true);
      expect(opts.quiet).toBe(true);
    });

    it('parses short flag options -r, -e, -q', () => {
      const opts = parseCliArgs(['-r', 'r.json', '-e', 'e.json', '-q']);
      expect(opts.receiptPathOrUrl).toBe('r.json');
      expect(opts.excerptPathOrUrl).toBe('e.json');
      expect(opts.quiet).toBe(true);
    });

    it('parses positional arguments and help flag', () => {
      const opts = parseCliArgs(['pos-r.json', 'pos-e.json', '-h']);
      expect(opts.receiptPathOrUrl).toBe('pos-r.json');
      expect(opts.excerptPathOrUrl).toBe('pos-e.json');
      expect(opts.help).toBe(true);
    });

    it('prints help message', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      printHelp();
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Audit Log Receipt Verifier CLI'));
    });
  });

  describe('runCli', () => {
    it('prints help and exits with 0 when -h is passed', async () => {
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runCli(['-h']);
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalled();
    });

    it('prints error and exits with 1 when arguments are missing', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli([]);
      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Both receipt and excerpt'));
    });

    it('exits with 0 when verification succeeds', async () => {
      const rows = createTestChain();
      const receipt = { total_rows: 3, expected_head_hash: rows[2].row_hash };

      (fs.promises.readFile as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(receipt))
        .mockResolvedValueOnce(JSON.stringify(rows));

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json']);

      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('PASS [VALID INTEGRITY PROOF]'));
    });

    it('outputs JSON when --json flag is passed', async () => {
      const rows = createTestChain();
      const receipt = { total_rows: 3, expected_head_hash: rows[2].row_hash };

      (fs.promises.readFile as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(receipt))
        .mockResolvedValueOnce(JSON.stringify(rows));

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json', '--json']);

      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"valid": true'));
    });

    it('exits with 1 when verification fails', async () => {
      const receipt = { total_rows: 5 };

      (fs.promises.readFile as jest.Mock)
        .mockResolvedValueOnce(JSON.stringify(receipt))
        .mockResolvedValueOnce(JSON.stringify([]));

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json']);

      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('FAIL'));
    });

    it('handles runtime error cleanly (e.g. invalid JSON)', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('invalid-json');

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json']);

      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('[VERIFIER ERROR]'));
    });

    it('handles runtime error with --json flag', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue('invalid-json');

      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json', '--json']);

      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"failureType":"RUNTIME_ERROR"'));
    });

    it('handles non-Error exception objects gracefully in runCli', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValue('String exception error');

      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['r.json', 'e.json']);

      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('String exception error'));
    });

    it('verifies start_id and end_id matching when both match', () => {
      const rows = createTestChain();
      const receipt: AuditReceipt = {
        start_id: rows[0].id,
        end_id: rows[2].id,
        start_prev_hash: AUDIT_LOG_GENESIS_HASH,
        expected_head_hash: rows[2].row_hash,
      };

      const res = verifyAuditReceipt(receipt, rows);
      expect(res.valid).toBe(true);
    });

    it('parses Date object instances in raw entries', () => {
      const dateObj = new Date('2026-01-15T10:00:00.000Z');
      const raw = [{ id: '1', created_at: dateObj, action: 'act' }];
      const parsed = parseLogExcerpt(JSON.stringify(raw));
      expect(parsed[0].created_at).toEqual(dateObj);
    });

    it('sorts entries with identical timestamp using id tie-breaker', () => {
      const sameDate = new Date('2026-01-15T10:00:00.000Z');
      const rA = makeRow({ id: 'a-id', action: 'actionA', created_at: sameDate });
      const rB = makeRow({ id: 'b-id', action: 'actionB', created_at: sameDate }, rA.row_hash);

      const res = verifyAuditReceipt(
        {
          total_rows: 2,
          start_prev_hash: AUDIT_LOG_GENESIS_HASH,
          expected_head_hash: rB.row_hash,
        },
        [rB, rA],
      );
      expect(res.valid).toBe(true);
    });

    it('formats report displaying step error details when step.error is present', () => {
      const rows = createTestChain();
      rows[1] = { ...rows[1], action: 'tampered' };
      const res = verifyAuditReceipt({}, rows);
      const report = formatReport(res);
      expect(report).toContain('Error:');
    });

    it('returns TRUNCATED_EXCERPT displaying start_id and end_id when specified on receipt', () => {
      const rows = createTestChain().slice(0, 1);
      const receipt: AuditReceipt = {
        total_rows: 3,
        start_id: 'id-start',
        end_id: 'id-end',
      };
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.actionableRecommendation).toContain('from start_id (id-start) to end_id (id-end)');
    });

    it('verifies valid chain when expected_head_hash is omitted from receipt', () => {
      const rows = createTestChain();
      const res = verifyAuditReceipt({}, rows);
      expect(res.valid).toBe(true);
      expect(res.receiptHeadHash).toBe(rows[2].row_hash);
    });

    it('formats report with empty computedHash step and no actionable recommendation', () => {
      const res = {
        valid: false,
        totalEntries: 1,
        verifiedEntries: 0,
        failureType: 'TEST_FAIL' as any,
        message: 'Test message',
        derivationTrace: [
          {
            index: 0,
            rowId: 'row-1',
            timestamp: '2026-01-15T10:00:00.000Z',
            prevHashMatch: false,
            computedHash: '',
            storedHash: 'stored',
            hashMatch: false,
          },
        ],
        durationMs: 1,
      };

      const output = formatReport(res);
      expect(output).toContain('Computed: N/A');
      expect(output).not.toContain('Action Required:');
    });

    it('handles http response with undefined statusCode', async () => {
      const mockReq = { on: jest.fn().mockImplementation(() => mockReq) };
      const mockRes = {
        statusCode: undefined,
        on: jest.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'data') cb('no-status-data');
          if (event === 'end') cb();
        }),
      };

      jest.spyOn(http, 'get').mockImplementation((url: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const res = await loadContent('http://example.com/nostatus.json');
      expect(res).toBe('no-status-data');
    });

    it('handles https response with undefined statusCode', async () => {
      const mockReq = { on: jest.fn().mockImplementation(() => mockReq) };
      const mockRes = {
        statusCode: undefined,
        on: jest.fn().mockImplementation((event: string, cb: any) => {
          if (event === 'data') cb('no-status-https-data');
          if (event === 'end') cb();
        }),
      };

      jest.spyOn(https, 'get').mockImplementation((url: any, cb: any) => {
        cb(mockRes);
        return mockReq as any;
      });

      const res = await loadContent('https://example.com/nostatus.json');
      expect(res).toBe('no-status-https-data');
    });

    it('returns TRUNCATED_EXCERPT with start_id set and end_id omitted', () => {
      const rows = createTestChain().slice(0, 1);
      const receipt: AuditReceipt = { total_rows: 3, start_id: 'start-10' };
      const res = verifyAuditReceipt(receipt, rows);
      expect(res.actionableRecommendation).toContain('from start_id (start-10) to end_id (N/A)');
    });

    it('exits with 1 in runCli when only receipt is provided without excerpt', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['-r', 'r.json']);
      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Both receipt and excerpt'));
    });

    it('exits with 1 in runCli when only excerpt is provided without receipt', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const code = await runCli(['-e', 'e.json']);
      expect(code).toBe(1);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('Both receipt and excerpt'));
    });

    it('handles positional args when receipt flag is already set', () => {
      const opts = parseCliArgs(['--receipt', 'flag-r.json', 'pos.json']);
      expect(opts.receiptPathOrUrl).toBe('flag-r.json');
      expect(opts.excerptPathOrUrl).toBe('pos.json');
    });

    it('handles positional args when excerpt flag is already set', () => {
      const opts = parseCliArgs(['--excerpt', 'flag-e.json', 'pos-r.json']);
      expect(opts.receiptPathOrUrl).toBe('pos-r.json');
      expect(opts.excerptPathOrUrl).toBe('flag-e.json');
    });

    it('ignores unknown flag arguments in parseCliArgs', () => {
      const opts = parseCliArgs(['--unknown-flag', '-r', 'r.json', '-e', 'e.json']);
      expect(opts.receiptPathOrUrl).toBe('r.json');
      expect(opts.excerptPathOrUrl).toBe('e.json');
    });
  });
});
