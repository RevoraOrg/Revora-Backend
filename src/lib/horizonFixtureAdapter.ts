import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import { AuditEvent, SecurityAuditRepository } from '../security/types';
import { OnChainRevenueState, StellarRevenueClient } from '../services/revenueReconciliationService';
import { createHash, createHmac, randomUUID } from 'crypto';

interface SignedReport {
  offeringId: string;
  periodStart: Date;
  periodEnd: Date;
  isBalanced: boolean;
  discrepancies: any[];
  summary: any;
  checkedAt: Date;
  fixtureHash?: string;
  signature: string;
}

export class HorizonFixtureAdapter implements StellarRevenueClient {
  private readonly metrics?: MetricsCollector;
  private readonly securityAuditRepo?: SecurityAuditRepository;
  private readonly signingKey?: string;

  constructor(
    options?: {
      metrics?: MetricsCollector;
      securityAuditRepo?: SecurityAuditRepository;
      signingKey?: string;
    }
  ) {
    this.metrics = options?.metrics;
    this.securityAuditRepo = options?.securityAuditRepo;
    this.signingKey = options?.signingKey;
  }

  async getRevenueState(fixtureUrl: string): Promise<OnChainRevenueState> {
    let responseBody: string;
    try {
      const response = await fetch(fixtureUrl);
      if (!response.ok) {
        throw new Error(
          `Fixture URL returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
        );
      }
      responseBody = await response.text();
      if (!responseBody || responseBody.trim().length === 0) {
        throw new Error(`Fixture URL "${fixtureUrl}" returned an empty response body`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTP')) throw err;
      throw new Error(
        `Failed to fetch fixture from "${fixtureUrl}": ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(responseBody);
    } catch {
      throw new Error(
        `Fixture URL "${fixtureUrl}" returned non-JSON content. ` +
        'Ensure the URL points to a valid Horizon snapshot JSON file.'
      );
    }

    if (this.securityAuditRepo) {
      await this.securityAuditRepo.record({
        id: randomUUID(),
        type: 'AUTHENTICATION',
        action: 'HORIZON_FIXTURE_ACCESS',
        resource: `horizon_fixture:${fixtureUrl}`,
        outcome: 'SUCCESS',
        details: {
          fixtureUrl,
          timestamp: new Date().toISOString(),
        },
        securityContext: {
          requestId: 'horizon-fixture-adapter',
          ipAddress: '0.0.0.0',
          userAgent: 'horizon-fixture-adapter/1.0',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      });
    }

    this.metrics?.incrementCounter('horizon_fixture_access_total', {
      fixtureUrl,
    });

    return {
      totalDistributed: String(data.totalDistributed ?? '0.00'),
    };
  }

  async getFixtureHash(fixtureUrl: string): Promise<string> {
    let responseBody: string;
    try {
      const response = await fetch(fixtureUrl);
      if (!response.ok) {
        throw new Error(
          `Fixture URL returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
        );
      }
      responseBody = await response.text();
      if (!responseBody || responseBody.trim().length === 0) {
        throw new Error(`Fixture URL "${fixtureUrl}" returned an empty response body`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('HTTP')) throw err;
      throw new Error(
        `Failed to fetch fixture from "${fixtureUrl}" for hashing: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const hash = createHash('sha256').update(responseBody, 'utf8').digest('hex');

    if (this.securityAuditRepo) {
      await this.securityAuditRepo.record({
        id: randomUUID(),
        type: 'AUTHENTICATION',
        action: 'HORIZON_FIXTURE_HASH',
        resource: `horizon_fixture:${fixtureUrl}`,
        outcome: 'SUCCESS',
        details: {
          fixtureUrl,
          hash,
          timestamp: new Date().toISOString(),
        },
        securityContext: {
          requestId: 'horizon-fixture-adapter',
          ipAddress: '0.0.0.0',
          userAgent: 'horizon-fixture-adapter/1.0',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      });
    }

    this.metrics?.incrementCounter('horizon_fixture_hash_total', {
      fixtureUrl,
    });

    return hash;
  }

  async signReport(report: any): Promise<SignedReport> {
    if (!this.signingKey) {
      throw Errors.internal('Signing key not configured');
    }

    const canonical = JSON.stringify(report);
    const hmac = createHmac('sha256', this.signingKey);
    hmac.update(canonical);
    const signature = `sha256=${hmac.digest('hex')}`;

    if (this.securityAuditRepo) {
      await this.securityAuditRepo.record({
        id: randomUUID(),
        type: 'AUTHENTICATION',
        action: 'REPORT_SIGNING',
        resource: `report:${report.offeringId}`,
        outcome: 'SUCCESS',
        details: {
          reportId: report.offeringId,
          timestamp: new Date().toISOString(),
        },
        securityContext: {
          requestId: 'horizon-fixture-adapter',
          ipAddress: '0.0.0.0',
          userAgent: 'horizon-fixture-adapter/1.0',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      });
    }

    this.metrics?.incrementCounter('report_signing_total', {
      reportId: report.offeringId,
    });

    return {
      ...report,
      signature,
    };
  }
}
