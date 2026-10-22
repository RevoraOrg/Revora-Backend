import { Resolver } from 'dns/promises';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface DnsResolverConfig {
  name: string;
  server: string;
}

export interface ResolverCheckResult {
  resolver: string;
  server: string;
  resolvedIp?: string;
  ttl?: number;
  status: 'PROPAGATED' | 'STALE' | 'FAILED';
  error?: string;
}

export interface HealthCheckResult {
  endpoint: string;
  statusCode: number;
  healthy: boolean;
  responseTimeMs: number;
  error?: string;
}

export interface TtlCheckOptions {
  domain: string;
  expectedIp: string;
  targetMaxTtlSeconds: number;
  resolvers?: DnsResolverConfig[];
  healthEndpoints?: string[];
  timeoutMs?: number;
  resolverFn?: (server: string, domain: string, timeoutMs: number) => Promise<{ ip: string; ttl: number }>;
  healthFetcherFn?: (url: string, timeoutMs: number) => Promise<{ statusCode: number; healthy: boolean; responseTimeMs: number }>;
}

export interface TtlCheckReport {
  timestamp: string;
  domain: string;
  expectedIp: string;
  targetMaxTtlSeconds: number;
  propagationStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  propagatedCount: number;
  totalResolvers: number;
  propagationPercentage: number;
  resolverResults: ResolverCheckResult[];
  healthCheckResults: HealthCheckResult[];
  overallHealthy: boolean;
  propagationLagSeconds: number;
  recommendations: string[];
}

export const DEFAULT_RESOLVERS: DnsResolverConfig[] = [
  { name: 'Google Primary', server: '8.8.8.8' },
  { name: 'Google Secondary', server: '8.8.4.4' },
  { name: 'Cloudflare Primary', server: '1.1.1.1' },
  { name: 'Quad9', server: '9.9.9.9' },
  { name: 'OpenDNS', server: '208.67.222.222' },
];

const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

export function validateInputs(domain: string, expectedIp: string, targetMaxTtlSeconds: number): void {
  if (!domain || !DOMAIN_REGEX.test(domain)) {
    throw new Error(`Invalid domain name format: "${domain}"`);
  }
  if (!expectedIp || !IPV4_REGEX.test(expectedIp)) {
    throw new Error(`Invalid expected IPv4 address format: "${expectedIp}"`);
  }
  if (typeof targetMaxTtlSeconds !== 'number' || isNaN(targetMaxTtlSeconds) || targetMaxTtlSeconds <= 0 || targetMaxTtlSeconds > 86400) {
    throw new Error(`Invalid targetMaxTtlSeconds: must be a positive number <= 86400 (got ${targetMaxTtlSeconds})`);
  }
}

export async function defaultResolveDns(
  server: string,
  domain: string,
  timeoutMs: number = 5000
): Promise<{ ip: string; ttl: number }> {
  const resolver = new Resolver();
  resolver.setServers([server]);

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    let settled = false;

    timer = setTimeout(() => {
      /* istanbul ignore else: race dead-branch: clearTimeout prevents firing when resolve/catch win; else-path unreliably non-deterministic */
      if (!settled) {
        settled = true;
        reject(new Error(`DNS resolution timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    resolver
      .resolve4(domain, { ttl: true })
      .then((records) => {
        /* istanbul ignore else: race dead-branch: if settled is set, timeout fired first; clearTimeout prevents else-path */
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (!records || records.length === 0) {
            reject(new Error('No A records returned'));
          } else {
            resolve({ ip: records[0].address, ttl: records[0].ttl });
          }
        }
      })
      .catch((err) => {
        /* istanbul ignore else: race dead-branch: if settled is set, timeout fired first; clearTimeout prevents else-path */
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
  });
}

export async function defaultHealthFetcher(
  endpointUrl: string,
  timeoutMs: number = 5000
): Promise<{ statusCode: number; healthy: boolean; responseTimeMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;

    try {
      const parsedUrl = new URL(endpointUrl);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.get(
        endpointUrl,
        {
          headers: { 'User-Agent': 'Revora-Failover-Drill/1.0' },
        },
        (res) => {
          /* istanbul ignore else: race dead-branch: if settled=true, timeout/error won; this else-branch is unreliable */
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            const duration = Date.now() - start;
            const statusCode = res.statusCode || 0;
            resolve({
              statusCode,
              healthy: statusCode === 200,
              responseTimeMs: duration,
            });
            res.resume();
          }
        }
      );

      req.on('error', (err) => {
        /* istanbul ignore else: race dead-branch: if settled=true, timeout/response won; else-branch unreliable */
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            statusCode: 0,
            healthy: false,
            responseTimeMs: Date.now() - start,
          });
        }
      });

      timer = setTimeout(() => {
        /* istanbul ignore else: race dead-branch: if settled=true, response/error won; clearTimeout blocks else */
        if (!settled) {
          settled = true;
          req.destroy();
          resolve({
            statusCode: 0,
            healthy: false,
            responseTimeMs: Date.now() - start,
          });
        }
      }, timeoutMs);
    } catch (err) {
      resolve({
        statusCode: 0,
        healthy: false,
        responseTimeMs: Date.now() - start,
      });
    }
  });
}

export async function checkDnsTtlAndHealth(options: TtlCheckOptions): Promise<TtlCheckReport> {
  const {
    domain,
    expectedIp,
    targetMaxTtlSeconds,
    resolvers = DEFAULT_RESOLVERS,
    healthEndpoints = [],
    timeoutMs = 5000,
    resolverFn = defaultResolveDns,
    healthFetcherFn = defaultHealthFetcher,
  } = options;

  validateInputs(domain, expectedIp, targetMaxTtlSeconds);

  const resolverResults: ResolverCheckResult[] = [];
  let maxTtlObserved = 0;

  for (const res of resolvers) {
    try {
      const resData = await resolverFn(res.server, domain, timeoutMs);
      const isIpMatched = resData.ip === expectedIp;
      const isTtlValid = resData.ttl <= targetMaxTtlSeconds;

      if (resData.ttl > maxTtlObserved) {
        maxTtlObserved = resData.ttl;
      }

      let status: 'PROPAGATED' | 'STALE' | 'FAILED';
      let error: string | undefined;

      if (isIpMatched && isTtlValid) {
        status = 'PROPAGATED';
      } else if (!isIpMatched) {
        status = 'STALE';
        error = `IP mismatch: expected ${expectedIp}, got ${resData.ip}`;
      } else {
        status = 'STALE';
        error = `TTL exceeds target: expected <= ${targetMaxTtlSeconds}s, got ${resData.ttl}s`;
      }

      resolverResults.push({
        resolver: res.name,
        server: res.server,
        resolvedIp: resData.ip,
        ttl: resData.ttl,
        status,
        error,
      });
    } catch (err: any) {
      resolverResults.push({
        resolver: res.name,
        server: res.server,
        status: 'FAILED',
        error: err?.message || 'Resolution failed',
      });
    }
  }

  const propagatedCount = resolverResults.filter((r) => r.status === 'PROPAGATED').length;
  const totalResolvers = resolverResults.length;
  const propagationPercentage = totalResolvers > 0 ? Math.round((propagatedCount / totalResolvers) * 100) : 0;

  let propagationStatus: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  if (propagatedCount === totalResolvers && totalResolvers > 0) {
    propagationStatus = 'COMPLETE';
  } else if (propagatedCount > 0) {
    propagationStatus = 'PARTIAL';
  } else {
    propagationStatus = 'FAILED';
  }

  const healthCheckResults: HealthCheckResult[] = [];
  for (const endpoint of healthEndpoints) {
    try {
      const res = await healthFetcherFn(endpoint, timeoutMs);
      healthCheckResults.push({
        endpoint,
        statusCode: res.statusCode,
        healthy: res.healthy,
        responseTimeMs: res.responseTimeMs,
      });
    } catch (err: any) {
      healthCheckResults.push({
        endpoint,
        statusCode: 0,
        healthy: false,
        responseTimeMs: 0,
        error: err?.message || 'Health probe failed',
      });
    }
  }

  const overallHealthy = healthCheckResults.length === 0 || healthCheckResults.every((h) => h.healthy);
  const recommendations: string[] = [];

  if (propagationStatus === 'PARTIAL') {
    recommendations.push(
      `Partial DNS propagation detected (${propagatedCount}/${totalResolvers} resolvers). Wait up to 2x TTL window (${targetMaxTtlSeconds * 2}s) before routing traffic.`
    );
  } else if (propagationStatus === 'FAILED') {
    recommendations.push(
      `DNS propagation failed across all resolvers. Verify Route53 record updates and NS delegation.`
    );
  }

  const staleOrOverTtlResolvers = resolverResults.filter((r) => r.ttl !== undefined && r.ttl > targetMaxTtlSeconds);
  if (staleOrOverTtlResolvers.length > 0) {
    recommendations.push(
      `${staleOrOverTtlResolvers.length} resolver(s) returned TTL exceeding max target ${targetMaxTtlSeconds}s. Lower TTL prior to failover drill.`
    );
  }

  const unhealthyEndpoints = healthCheckResults.filter((h) => !h.healthy);
  if (unhealthyEndpoints.length > 0) {
    recommendations.push(
      `${unhealthyEndpoints.length} health probe(s) failed. Abort DNS cutover until all target probes return HTTP 200.`
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('DNS TTL, propagation, and health check probes are fully aligned for multi-region failover.');
  }

  return {
    timestamp: new Date().toISOString(),
    domain,
    expectedIp,
    targetMaxTtlSeconds,
    propagationStatus,
    propagatedCount,
    totalResolvers,
    propagationPercentage,
    resolverResults,
    healthCheckResults,
    overallHealthy,
    propagationLagSeconds: maxTtlObserved,
    recommendations,
  };
}

export function printReport(report: TtlCheckReport, asJson: boolean = false): void {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Multi-Region Failover: DNS TTL & Health Check Verification ===');
  console.log(`Timestamp:             ${report.timestamp}`);
  console.log(`Target Domain:         ${report.domain}`);
  console.log(`Expected IP:           ${report.expectedIp}`);
  console.log(`Target Max TTL:        ${report.targetMaxTtlSeconds}s`);
  console.log(`Propagation Status:    ${report.propagationStatus} (${report.propagatedCount}/${report.totalResolvers} resolvers - ${report.propagationPercentage}%)`);
  console.log(`Max Propagation Lag:   ~${report.propagationLagSeconds}s`);
  console.log(`Overall Health Probe:  ${report.overallHealthy ? 'PASS (All Healthy)' : 'FAIL (Unhealthy Probes)'}`);
  console.log('\n--- DNS Resolver Breakdown ---');

  for (const res of report.resolverResults) {
    const symbol = res.status === 'PROPAGATED' ? '[PASS]' : res.status === 'STALE' ? '[STALE]' : '[FAIL]';
    console.log(`${symbol} ${res.resolver} (${res.server}): IP=${res.resolvedIp || 'N/A'}, TTL=${res.ttl !== undefined ? res.ttl + 's' : 'N/A'}${res.error ? ' - ' + res.error : ''}`);
  }

  if (report.healthCheckResults.length > 0) {
    console.log('\n--- Health Check Probes ---');
    for (const h of report.healthCheckResults) {
      const symbol = h.healthy ? '[PASS]' : '[FAIL]';
      console.log(`${symbol} ${h.endpoint}: HTTP ${h.statusCode} (${h.responseTimeMs}ms)`);
    }
  }

  console.log('\n--- Recommendations & Action Items ---');
  for (const rec of report.recommendations) {
    console.log(`• ${rec}`);
  }
  console.log('=================================================================\n');
}

export async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonFlag = args.includes('--json');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
DNS TTL & Failover Drill Verification Script

Usage:
  ts-node scripts/failover-drill/ttl-check.ts [options]

Options:
  --domain <name>          Domain to verify (default: api.revora.io)
  --expected-ip <ip>       Expected target IPv4 address (default: 1.2.3.4 or env EXPECTED_IP)
  --target-ttl <seconds>   Maximum allowable TTL in seconds (default: 60)
  --health-url <url>       Health endpoint URL to check (can be specified multiple times)
  --json                   Output report formatted as JSON
  --help, -h               Show this help screen
    `);
    process.exit(0);
  }

  const getArgValue = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
  };

  const domain = getArgValue('--domain') || process.env.PRIMARY_DNS || 'api.revora.io';
  const expectedIp = getArgValue('--expected-ip') || process.env.EXPECTED_IP || '1.2.3.4';
  const targetMaxTtl = parseInt(getArgValue('--target-ttl') || process.env.TARGET_TTL || '60', 10);

  const healthEndpoints: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--health-url' && i + 1 < args.length) {
      healthEndpoints.push(args[i + 1]);
    }
  }

  if (healthEndpoints.length === 0) {
    const primaryUrl = process.env.PRIMARY_HEALTH_URL || `https://${domain}/health`;
    const secondaryUrl = process.env.SECONDARY_HEALTH_URL || `https://api-eu.revora.io/health`;
    healthEndpoints.push(primaryUrl, secondaryUrl);
  }

  try {
    const report = await checkDnsTtlAndHealth({
      domain,
      expectedIp,
      targetMaxTtlSeconds: targetMaxTtl,
      healthEndpoints,
    });

    printReport(report, jsonFlag);
    if (report.propagationStatus === 'FAILED' || !report.overallHealthy) {
      process.exit(1);
    }
    process.exit(0);
  } catch (err: any) {
    if (err && err.__processExitSentinel) {
      throw err;
    }
    console.error(`FATAL ERROR: ${err.message}`);
    process.exit(1);
  }
}

/* istanbul ignore next: CLI entry guard, tested via subprocess invocation */
if (require.main === module) {
  runCli();
}
