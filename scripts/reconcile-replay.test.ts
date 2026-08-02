import { createHash, createHmac } from 'node:crypto';
import {
  runReconcileReplayCli,
  fetchHorizonFixture,
  HorizonFixtureClient,
  ReplayReport,
} from './reconcile-replay';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the database pool
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock the revenue reconciliation service
jest.mock('../src/services/revenueReconciliationService', () => {
  const mockReconcile = jest.fn();
  return {
    RevenueReconciliationService: jest.fn().mockImplementation(() => ({
      reconcile: mockReconcile,
    })),
    __mockReconcile: mockReconcile,
  };
});

// Mock globalMetrics
jest.mock('../src/lib/metrics', () => ({
  globalMetrics: {
    incrementCounter: jest.fn(),
    setGauge: jest.fn(),
  },
}));

// Mock fetch for fixture tests
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function signReport(report: ReplayReport, secret: string): string {
  const canonical = JSON.stringify(report);
  const hmac = createHmac('sha256', secret);
  hmac.update(canonical);
  return `sha256=${hmac.digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reconcile-replay CLI', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.argv = ['node', 'reconcile-replay.ts'];
    process.env = { ...originalEnv };
    mockFetch.mockReset();
  });

  afterAll(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // fetchHorizonFixture
  // -----------------------------------------------------------------------

  describe('fetchHorizonFixture', () => {
    it('fetches and parses a valid JSON fixture', async () => {
      const fixtureData = { totalDistributed: '1000.00' };
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(fixtureData)),
      });

      const result = await fetchHorizonFixture('https://example.com/fixture.json');
      expect(result.data).toEqual(fixtureData);
      expect(result.body).toBe(JSON.stringify(fixtureData));
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(fetchHorizonFixture('https://example.com/fixture.json'))
        .rejects.toThrow('Failed to connect to fixture URL');
    });

    it('throws on HTTP error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchHorizonFixture('https://example.com/fixture.json'))
        .rejects.toThrow('HTTP 404');
    });

    it('throws on empty response body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(''),
      });

      await expect(fetchHorizonFixture('https://example.com/fixture.json'))
        .rejects.toThrow('empty response body');
    });

    it('throws on non-JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Not JSON</html>'),
      });

      await expect(fetchHorizonFixture('https://example.com/fixture.json'))
        .rejects.toThrow('non-JSON content');
    });
  });

  // -----------------------------------------------------------------------
  // signReport
  // -----------------------------------------------------------------------

  describe('signReport', () => {
    it('produces a consistent HMAC-SHA256 signature', () => {
      const report: ReplayReport = {
        schema_version: 1,
        generated_at: '2023-01-15T10:00:00Z',
        fixture_sha256: 'abc123',
        fixture_url: 'https://example.com/fixture.json',
        parameters: {
          offering_id: 'offering-123',
          period_start: '2023-01-01',
          period_end: '2023-01-31',
        },
        reconciliation: {
          offeringId: 'offering-123',
          periodStart: new Date('2023-01-01'),
          periodEnd: new Date('2023-01-31'),
          isBalanced: true,
          discrepancies: [],
          summary: {
            totalRevenueReported: '1000.00',
            totalPayouts: '1000.00',
            discrepancyAmount: '0.00',
            investorCount: 5,
            payoutsProcessed: 10,
            payoutsFailed: 0,
          },
          checkedAt: new Date('2023-01-15T10:00:00Z'),
        },
      };

      const secret = 'test-secret';
      const sig1 = signReport(report, secret);
      const sig2 = signReport(report, secret);

      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('produces different signatures with different secrets', () => {
      const report: ReplayReport = {
        schema_version: 1,
        generated_at: '2023-01-15T10:00:00Z',
        fixture_sha256: 'abc123',
        fixture_url: 'https://example.com/fixture.json',
        parameters: {
          offering_id: 'offering-123',
          period_start: '2023-01-01',
          period_end: '2023-01-31',
        },
        reconciliation: {
          offeringId: 'offering-123',
          periodStart: new Date('2023-01-01'),
          periodEnd: new Date('2023-01-31'),
          isBalanced: true,
          discrepancies: [],
          summary: {
            totalRevenueReported: '1000.00',
            totalPayouts: '1000.00',
            discrepancyAmount: '0.00',
            investorCount: 5,
            payoutsProcessed: 10,
            payoutsFailed: 0,
          },
          checkedAt: new Date('2023-01-15T10:00:00Z'),
        },
      };

      const sig1 = signReport(report, 'secret-1');
      const sig2 = signReport(report, 'secret-2');

      expect(sig1).not.toBe(sig2);
    });
  });

  // -----------------------------------------------------------------------
  // HorizonFixtureClient
  // -----------------------------------------------------------------------

  describe('HorizonFixtureClient', () => {
    it('returns totalDistributed from fixture', async () => {
      const fixture = { totalDistributed: '5000.00' };
      const client = new HorizonFixtureClient(fixture);

      const result = await client.getRevenueState('contract-123');
      expect(result.totalDistributed).toBe('5000.00');
    });

    it('defaults to 0.00 when totalDistributed is missing', async () => {
      const fixture = { totalDistributed: undefined } as any;
      const client = new HorizonFixtureClient(fixture);

      const result = await client.getRevenueState('contract-123');
      expect(result.totalDistributed).toBe('0.00');
    });
  });

  // -----------------------------------------------------------------------
  // CLI argument validation
  // -----------------------------------------------------------------------

  describe('CLI argument validation', () => {
    it('shows help with --help flag', async () => {
      process.argv = ['node', 'reconcile-replay.ts', '--help'];
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(0);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage:')
      );

      consoleSpy.mockRestore();
    });

    it('shows help with -h flag', async () => {
      process.argv = ['node', 'reconcile-replay.ts', '-h'];
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(0);

      consoleSpy.mockRestore();
    });

    it('returns error with missing arguments', async () => {
      process.argv = ['node', 'reconcile-replay.ts'];
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Missing required arguments')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error for invalid period_start', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', 'not-a-date', 'https://example.com/fixture.json'];
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid period_start')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error for invalid period_end', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json', 'not-a-date'];
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid period_end')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error when period_end is before period_start', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-31', 'https://example.com/fixture.json', '2023-01-01'];
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('period_end must be after period_start')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error for empty offering_id', async () => {
      process.argv = ['node', 'reconcile-replay.ts', '', '2023-01-01', 'https://example.com/fixture.json'];
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);

      consoleErrorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Environment variable validation
  // -----------------------------------------------------------------------

  describe('environment variable validation', () => {
    it('returns error when DATABASE_URL is missing', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      delete process.env.DATABASE_URL;
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      // Mock fetch to succeed
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ totalDistributed: '1000.00' })),
      });

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('DATABASE_URL')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error when REPLAY_SIGNING_SECRET is missing', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      delete process.env.REPLAY_SIGNING_SECRET;
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      // Mock fetch to succeed
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ totalDistributed: '1000.00' })),
      });

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('REPLAY_SIGNING_SECRET')
      );

      consoleErrorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Fixture error handling
  // -----------------------------------------------------------------------

  describe('fixture error handling', () => {
    it('returns error when fixture fetch fails', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      mockFetch.mockRejectedValue(new Error('Network error'));

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect to fixture URL')
      );

      consoleErrorSpy.mockRestore();
    });

    it('returns error when fixture returns non-JSON', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue('<html>Not JSON</html>'),
      });

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-JSON content')
      );

      consoleErrorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Full CLI execution
  // -----------------------------------------------------------------------

  describe('full CLI execution', () => {
    it('produces a signed report on successful reconciliation', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';

      const fixtureData = { totalDistributed: '1000.00' };
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(fixtureData)),
      });

      const mockReconcile = require('../src/services/revenueReconciliationService').__mockReconcile;
      mockReconcile.mockResolvedValue({
        offeringId: 'offering-1',
        periodStart: new Date('2023-01-01'),
        periodEnd: new Date(),
        isBalanced: true,
        discrepancies: [],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '1000.00',
          discrepancyAmount: '0.00',
          investorCount: 5,
          payoutsProcessed: 10,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(0);

      // Verify the output is valid JSON with signature
      const output = consoleSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      expect(parsed.report).toBeDefined();
      expect(parsed.signature).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(parsed.report.fixture_sha256).toBe(sha256(JSON.stringify(fixtureData)));
      expect(parsed.report.parameters.offering_id).toBe('offering-1');

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('returns exit code 1 when reconciliation is not balanced', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';

      const fixtureData = { totalDistributed: '1000.00' };
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(fixtureData)),
      });

      const mockReconcile = require('../src/services/revenueReconciliationService').__mockReconcile;
      mockReconcile.mockResolvedValue({
        offeringId: 'offering-1',
        periodStart: new Date('2023-01-01'),
        periodEnd: new Date(),
        isBalanced: false,
        discrepancies: [
          {
            type: 'REVENUE_MISMATCH',
            severity: 'error',
            message: 'Revenue mismatch',
            details: {},
            offeringId: 'offering-1',
          },
        ],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '900.00',
          discrepancyAmount: '100.00',
          investorCount: 5,
          payoutsProcessed: 10,
          payoutsFailed: 0,
        },
        checkedAt: new Date(),
      });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('handles reconciliation service errors', async () => {
      process.argv = ['node', 'reconcile-replay.ts', 'offering-1', '2023-01-01', 'https://example.com/fixture.json'];
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.REPLAY_SIGNING_SECRET = 'test-secret';

      const fixtureData = { totalDistributed: '1000.00' };
      mockFetch.mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(fixtureData)),
      });

      const mockReconcile = require('../src/services/revenueReconciliationService').__mockReconcile;
      mockReconcile.mockRejectedValue(new Error('Database connection failed'));

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const code = await runReconcileReplayCli();
      expect(code).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reconciliation replay failed')
      );

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });
});
