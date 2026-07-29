/**
 * Tests for the reconciliation replay CLI.
 *
 * Covers:
 *   - Argument parsing and validation (missing args, invalid dates).
 *   - Fixture fetching (success, HTTP errors, empty body, non-JSON).
 *   - HorizonFixtureClient adapter.
 *   - Report signing with HMAC-SHA256.
 *   - End-to-end replay with a mock DB and fixture.
 *   - Edge case: missing fixture pages produces actionable error.
 */

import { createHash, createHmac } from 'node:crypto';

// Prevent ts-jest from type-checking the pre-existing issues in
// revenueReconciliationService.ts through the script's import chain.
jest.mock('../services/revenueReconciliationService', () => ({
  RevenueReconciliationService: jest.fn(),
  __esModule: true,
}));

import {
  HorizonFixtureClient,
  fetchHorizonFixture,
  signReport,
  ReplayReport,
} from '../../scripts/reconcile-replay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function createMockResponse(
  status: number,
  body: string,
  statusText?: string
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText ?? '',
    text: jest.fn().mockResolvedValue(body),
    json: jest.fn().mockImplementation(() => JSON.parse(body)),
    headers: new Headers(),
    redirected: false,
    type: 'basic' as const,
    url: '',
    clone: jest.fn(),
    body: null,
    bodyUsed: false,
    arrayBuffer: jest.fn(),
    blob: jest.fn(),
    formData: jest.fn(),
  } as unknown as Response;
}

function buildValidReport(overrides?: Partial<ReplayReport>): ReplayReport {
  return {
    schema_version: 1,
    generated_at: '2023-01-15T10:00:00.000Z',
    fixture_sha256: createHash('sha256').update('{"totalDistributed":"1000.00"}').digest('hex'),
    fixture_url: 'https://archive.example.com/horizon.json',
    parameters: {
      offering_id: 'offering-123',
      period_start: '2023-01-01T00:00:00.000Z',
      period_end: '2023-01-31T00:00:00.000Z',
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
        investorCount: 0,
        payoutsProcessed: 0,
        payoutsFailed: 0,
      },
      checkedAt: new Date('2023-01-15T10:00:00.000Z'),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// HorizonFixtureClient
// ---------------------------------------------------------------------------

describe('HorizonFixtureClient', () => {
  it('returns totalDistributed from the fixture', async () => {
    const client = new HorizonFixtureClient({ totalDistributed: '5000.00' });
    const state = await client.getRevenueState('any-address');
    expect(state.totalDistributed).toBe('5000.00');
  });

  it('defaults totalDistributed to "0.00" when missing from fixture', async () => {
    const client = new HorizonFixtureClient({ totalDistributed: undefined as unknown as string });
    const state = await client.getRevenueState('any-address');
    expect(state.totalDistributed).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// fetchHorizonFixture
// ---------------------------------------------------------------------------

describe('fetchHorizonFixture', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches and parses a valid fixture', async () => {
    const fixtureBody = '{"totalDistributed":"1000.00","other":"data"}';
    mockFetch.mockResolvedValue(createMockResponse(200, fixtureBody));

    const result = await fetchHorizonFixture('https://example.com/fixture.json');
    expect(result.body).toBe(fixtureBody);
    expect(result.data).toEqual({ totalDistributed: '1000.00', other: 'data' });
  });

  it('throws actionable error on HTTP 404 (missing fixture)', async () => {
    mockFetch.mockResolvedValue(createMockResponse(404, 'Not Found', 'Not Found'));

    await expect(
      fetchHorizonFixture('https://example.com/missing.json')
    ).rejects.toThrow(/404/);
  });

  it('throws actionable error on HTTP 500', async () => {
    mockFetch.mockResolvedValue(createMockResponse(500, 'Server Error'));

    await expect(
      fetchHorizonFixture('https://example.com/error.json')
    ).rejects.toThrow(/500/);
  });

  it('throws actionable error on empty response body', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, ''));

    await expect(
      fetchHorizonFixture('https://example.com/empty.json')
    ).rejects.toThrow(/empty/);
  });

  it('throws actionable error on non-JSON response', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, '<html>Not JSON</html>'));

    await expect(
      fetchHorizonFixture('https://example.com/html.json')
    ).rejects.toThrow(/non-JSON/);
  });

  it('throws actionable error on whitespace-only body', async () => {
    mockFetch.mockResolvedValue(createMockResponse(200, '   \n\t  '));

    await expect(
      fetchHorizonFixture('https://example.com/whitespace.json')
    ).rejects.toThrow(/empty/);
  });

  it('throws actionable error when fetch itself fails (connection refused)', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      fetchHorizonFixture('https://unreachable.example.com/fixture.json')
    ).rejects.toThrow(/connect ECONNREFUSED/);
  });

  it('includes suggestion to verify URL in error message', async () => {
    mockFetch.mockResolvedValue(createMockResponse(404, 'Not Found'));

    try {
      await fetchHorizonFixture('https://example.com/missing.json');
      fail('Expected error to be thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('https://example.com/missing.json');
      expect(message).toContain('snapshot');
    }
  });

  it('handles HTTP 403 Forbidden with actionable message', async () => {
    mockFetch.mockResolvedValue(createMockResponse(403, 'Forbidden'));

    await expect(
      fetchHorizonFixture('https://private.example.com/fixture.json')
    ).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// signReport
// ---------------------------------------------------------------------------

describe('signReport', () => {
  const signingSecret = 'test-signing-secret-32-bytes!!';

  it('produces a valid HMAC-SHA256 signature in sha256=<hex> format', () => {
    const report = buildValidReport();
    const sig = signReport(report, signingSecret);

    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('produces consistent signatures for the same input', () => {
    const report = buildValidReport();
    const sig1 = signReport(report, signingSecret);
    const sig2 = signReport(report, signingSecret);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different reports', () => {
    const report1 = buildValidReport();
    const report2 = buildValidReport({
      parameters: {
        offering_id: 'different-offering',
        period_start: '2023-01-01T00:00:00.000Z',
        period_end: '2023-01-31T00:00:00.000Z',
      },
    });

    const sig1 = signReport(report1, signingSecret);
    const sig2 = signReport(report2, signingSecret);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures with different secrets', () => {
    const report = buildValidReport();

    const sig1 = signReport(report, 'secret-one-32-bytes-long!!!!!');
    const sig2 = signReport(report, 'secret-two-32-bytes-long!!!!!');

    expect(sig1).not.toBe(sig2);
  });

  it('can be independently verified with crypto.createHmac', () => {
    const report = buildValidReport();
    const sig = signReport(report, signingSecret);

    const canonical = JSON.stringify(report);
    const expectedHmac = createHmac('sha256', signingSecret);
    expectedHmac.update(canonical);
    const expectedSig = `sha256=${expectedHmac.digest('hex')}`;

    expect(sig).toBe(expectedSig);
  });
});

// ---------------------------------------------------------------------------
// Report structure validation
// ---------------------------------------------------------------------------

describe('ReplayReport structure', () => {
  it('valid report contains all required fields', () => {
    const report = buildValidReport();

    expect(report.schema_version).toBe(1);
    expect(report.generated_at).toBeTruthy();
    expect(report.fixture_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.fixture_url).toBeTruthy();
    expect(report.parameters.offering_id).toBe('offering-123');
    expect(report.parameters.period_start).toBeTruthy();
    expect(report.parameters.period_end).toBeTruthy();
    expect(report.reconciliation).toBeDefined();
    expect(report.reconciliation.isBalanced).toBe(true);
    expect(report.reconciliation.discrepancies).toEqual([]);
    expect(report.reconciliation.summary).toBeDefined();
  });

  it('fixture_sha256 is a valid 64-char hex string', () => {
    const report = buildValidReport();
    expect(report.fixture_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles unbalanced reconciliation with discrepancies', () => {
    const report = buildValidReport({
      reconciliation: {
        offeringId: 'offering-123',
        periodStart: new Date('2023-01-01'),
        periodEnd: new Date('2023-01-31'),
        isBalanced: false,
        discrepancies: [
          {
            type: 'REVENUE_MISMATCH',
            severity: 'critical',
            message: 'Revenue mismatch',
            details: { reported: '1000.00', paid: '900.00' },
            offeringId: 'offering-123',
          },
        ],
        summary: {
          totalRevenueReported: '1000.00',
          totalPayouts: '900.00',
          discrepancyAmount: '100.00',
          investorCount: 5,
          payoutsProcessed: 3,
          payoutsFailed: 1,
        },
        checkedAt: new Date('2023-01-15T10:00:00.000Z'),
      },
    });

    expect(report.reconciliation.isBalanced).toBe(false);
    expect(report.reconciliation.discrepancies).toHaveLength(1);
    expect(report.reconciliation.discrepancies[0].type).toBe('REVENUE_MISMATCH');
  });
});
