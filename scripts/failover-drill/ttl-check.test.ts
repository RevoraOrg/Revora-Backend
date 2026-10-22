import {
  checkDnsTtlAndHealth,
  validateInputs,
  printReport,
  runCli,
  defaultResolveDns,
  defaultHealthFetcher,
  TtlCheckOptions,
  DEFAULT_RESOLVERS,
} from './ttl-check';
import * as http from 'http';
import * as https from 'https';
import { Resolver } from 'dns/promises';

describe('validateInputs', () => {
  it('accepts valid inputs', () => {
    expect(() => validateInputs('api.revora.io', '1.2.3.4', 60)).not.toThrow();
    expect(() => validateInputs('sub.domain.co.uk', '192.168.1.1', 300)).not.toThrow();
    expect(() => validateInputs('a.io', '1.2.3.4', 86400)).not.toThrow();
  });

  it('rejects invalid domain names', () => {
    expect(() => validateInputs('', '1.2.3.4', 60)).toThrow(/Invalid domain name format/);
    expect(() => validateInputs('invalid_domain!', '1.2.3.4', 60)).toThrow(/Invalid domain name format/);
  });

  it('rejects invalid IPv4 addresses', () => {
    expect(() => validateInputs('api.revora.io', 'invalid-ip', 60)).toThrow(/Invalid expected IPv4 address format/);
    expect(() => validateInputs('api.revora.io', '256.1.1.1', 60)).toThrow(/Invalid expected IPv4 address format/);
  });

  it('rejects invalid target TTLs', () => {
    expect(() => validateInputs('api.revora.io', '1.2.3.4', 0)).toThrow(/Invalid targetMaxTtlSeconds/);
    expect(() => validateInputs('api.revora.io', '1.2.3.4', -10)).toThrow(/Invalid targetMaxTtlSeconds/);
    expect(() => validateInputs('api.revora.io', '1.2.3.4', 100000)).toThrow(/Invalid targetMaxTtlSeconds/);
    expect(() => validateInputs('api.revora.io', '1.2.3.4', NaN)).toThrow(/Invalid targetMaxTtlSeconds/);
  });
});

describe('checkDnsTtlAndHealth', () => {
  const mockResolvers = [
    { name: 'Resolver A', server: '1.1.1.1' },
    { name: 'Resolver B', server: '8.8.8.8' },
    { name: 'Resolver C', server: '9.9.9.9' },
  ];

  it('reports COMPLETE propagation when all resolvers match expected IP and TTL', async () => {
    const mockResolverFn = jest.fn().mockImplementation(async (server: string) => {
      return { ip: '1.2.3.4', ttl: 30 };
    });

    const mockHealthFn = jest.fn().mockImplementation(async (url: string) => {
      return { statusCode: 200, healthy: true, responseTimeMs: 25 };
    });

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      healthEndpoints: ['https://api.revora.io/health'],
      resolverFn: mockResolverFn,
      healthFetcherFn: mockHealthFn,
    });

    expect(report.propagationStatus).toBe('COMPLETE');
    expect(report.propagatedCount).toBe(3);
    expect(report.totalResolvers).toBe(3);
    expect(report.propagationPercentage).toBe(100);
    expect(report.overallHealthy).toBe(true);
    expect(report.propagationLagSeconds).toBe(30);
    expect(report.resolverResults[0].status).toBe('PROPAGATED');
  });

  it('reports PARTIAL propagation clearly when some resolvers return old IP or high TTL', async () => {
    const mockResolverFn = jest.fn().mockImplementation(async (server: string) => {
      if (server === '1.1.1.1') return { ip: '1.2.3.4', ttl: 30 };
      if (server === '8.8.8.8') return { ip: '5.6.7.8', ttl: 30 };
      return { ip: '1.2.3.4', ttl: 120 };
    });

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      resolverFn: mockResolverFn,
    });

    expect(report.propagationStatus).toBe('PARTIAL');
    expect(report.propagatedCount).toBe(1);
    expect(report.totalResolvers).toBe(3);
    expect(report.propagationPercentage).toBe(33);
    expect(report.resolverResults[0].status).toBe('PROPAGATED');
    expect(report.resolverResults[1].status).toBe('STALE');
    expect(report.resolverResults[1].error).toContain('IP mismatch');
    expect(report.resolverResults[2].status).toBe('STALE');
    expect(report.resolverResults[2].error).toContain('TTL exceeds target');
    expect(report.recommendations.some((r) => r.includes('Partial DNS propagation detected'))).toBe(true);
    expect(report.recommendations.some((r) => r.includes('returned TTL exceeding max target'))).toBe(true);
  });

  it('reports PARTIAL propagation where only TTL varies (all IPs correct, some TTLs too high)', async () => {
    const partialTtlResolverFn = jest.fn().mockImplementation(async (server: string) => {
      if (server === '1.1.1.1') return { ip: '1.2.3.4', ttl: 30 };
      if (server === '8.8.8.8') return { ip: '1.2.3.4', ttl: 45 };
      return { ip: '1.2.3.4', ttl: 120 };
    });

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      resolverFn: partialTtlResolverFn,
    });

    expect(report.propagationStatus).toBe('PARTIAL');
    expect(report.propagatedCount).toBe(2);
    expect(report.totalResolvers).toBe(3);
    expect(report.resolverResults[0].status).toBe('PROPAGATED');
    expect(report.resolverResults[1].status).toBe('PROPAGATED');
    expect(report.resolverResults[2].status).toBe('STALE');
    expect(report.resolverResults[2].error).toContain('TTL exceeds target');
  });

  it('reports FAILED propagation when all resolvers fail', async () => {
    const mockResolverFn = jest.fn().mockRejectedValue(new Error('DNS query timeout'));

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      resolverFn: mockResolverFn,
    });

    expect(report.propagationStatus).toBe('FAILED');
    expect(report.propagatedCount).toBe(0);
    expect(report.propagationPercentage).toBe(0);
    expect(report.resolverResults.every((r) => r.status === 'FAILED')).toBe(true);
    expect(report.recommendations.some((r) => r.includes('DNS propagation failed across all resolvers'))).toBe(true);
  });

  it('handles string-based rejection (err?.message falsy, err is object/string non-null) in resolver catch block (falls back to generic message)', async () => {
    const mockResolverFn = jest.fn().mockRejectedValue('Plain string error');
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [{ name: 'Bad Resolver', server: '1.1.1.1' }],
      resolverFn: mockResolverFn,
    });
    expect(report.propagationStatus).toBe('FAILED');
    expect(report.resolverResults[0].status).toBe('FAILED');
    expect(report.resolverResults[0].error).toBe('Resolution failed');
  });

  it('handles throw null (err=null, optional-chaining null-path) in resolver catch to cover err?.message null branch', async () => {
    const nullRejectResolver: any = jest.fn().mockRejectedValue(null);
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [{ name: 'Null Reject Resolver', server: '1.1.1.1' }],
      resolverFn: nullRejectResolver,
    });
    expect(report.propagationStatus).toBe('FAILED');
    expect(report.resolverResults[0].status).toBe('FAILED');
    expect(report.resolverResults[0].error).toBe('Resolution failed');
  });

  it('reports distinct TTL_NOT_YET_SHORTENED state: all correct IPs but ALL TTLs exceed target (propagationStatus = FAILED, 0 propagated)', async () => {
    const allHighTtlResolverFn = jest.fn().mockImplementation(async () => {
      return { ip: '1.2.3.4', ttl: 300 };
    });

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      resolverFn: allHighTtlResolverFn,
    });

    expect(report.propagationStatus).toBe('FAILED');
    expect(report.propagatedCount).toBe(0);
    expect(report.totalResolvers).toBe(3);
    expect(report.propagationPercentage).toBe(0);
    expect(report.resolverResults.every((r) => r.status === 'STALE')).toBe(true);
    expect(report.resolverResults.every((r) => r.error && r.error.includes('TTL exceeds target'))).toBe(true);
    expect(report.recommendations.some((r) => r.includes('returned TTL exceeding max target'))).toBe(true);
    expect(report.recommendations.some((r) => r.includes('DNS propagation failed across all resolvers'))).toBe(true);
    expect(report.propagationLagSeconds).toBe(300);
  });

  it('handles health check failures and non-error exception objects in catch block', async () => {
    const mockResolverFn = jest.fn().mockResolvedValue({ ip: '1.2.3.4', ttl: 30 });
    const mockHealthFn = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes('primary')) return { statusCode: 503, healthy: false, responseTimeMs: 100 };
      throw 'Raw string exception';
    });

    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: mockResolvers,
      healthEndpoints: ['https://primary.revora.io/health', 'https://secondary.revora.io/health'],
      resolverFn: mockResolverFn,
      healthFetcherFn: mockHealthFn,
    });

    expect(report.overallHealthy).toBe(false);
    expect(report.healthCheckResults[0].statusCode).toBe(503);
    expect(report.healthCheckResults[0].healthy).toBe(false);
    expect(report.healthCheckResults[1].healthy).toBe(false);
    expect(report.healthCheckResults[1].error).toBe('Health probe failed');
    expect(report.recommendations.some((r) => r.includes('health probe(s) failed'))).toBe(true);
  });

  it('uses DEFAULT_RESOLVERS when none provided', async () => {
    const mockResolverFn = jest.fn().mockResolvedValue({ ip: '1.2.3.4', ttl: 30 });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolverFn: mockResolverFn,
    });

    expect(report.totalResolvers).toBe(DEFAULT_RESOLVERS.length);
  });

  it('handles empty resolvers array gracefully (totalResolvers=0 branch, propagationPercentage=0)', async () => {
    const mockResolverFn = jest.fn().mockResolvedValue({ ip: '1.2.3.4', ttl: 30 });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [],
      resolverFn: mockResolverFn,
      healthFetcherFn: jest.fn().mockResolvedValue({ statusCode: 200, healthy: true, responseTimeMs: 10 }),
    });

    expect(report.propagatedCount).toBe(0);
    expect(report.totalResolvers).toBe(0);
    expect(report.propagationPercentage).toBe(0);
    expect(report.propagationStatus).toBe('FAILED');
    expect(mockResolverFn).not.toHaveBeenCalled();
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});

describe('printReport', () => {
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('prints human readable report format with failed resolver and health checks', async () => {
    const mockResolverFn = jest.fn().mockImplementation(async (server: string) => {
      if (server === '1.1.1.1') return { ip: '1.2.3.4', ttl: 30 };
      throw new Error('Resolver down');
    });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [{ name: 'Pass Resolver', server: '1.1.1.1' }, { name: 'Fail Resolver', server: '8.8.8.8' }],
      healthEndpoints: ['https://api.revora.io/health'],
      resolverFn: mockResolverFn,
      healthFetcherFn: jest.fn().mockResolvedValue({ statusCode: 503, healthy: false, responseTimeMs: 15 }),
    });

    printReport(report, false);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Multi-Region Failover: DNS TTL & Health Check Verification'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[PASS] Pass Resolver (1.1.1.1)'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[FAIL] Fail Resolver (8.8.8.8)'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[FAIL] https://api.revora.io/health: HTTP 503'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Overall Health Probe:  FAIL'));
  });

  it('prints STALE resolver status and HEALTH=PASS branches in human readable output', async () => {
    const staleTtlResolver = jest.fn().mockImplementation(async (server: string) => {
      if (server === '1.1.1.1') return { ip: '1.2.3.4', ttl: 300 };
      return { ip: '5.5.5.5', ttl: 30 };
    });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [
        { name: 'Stale-TTL Resolver', server: '1.1.1.1' },
        { name: 'Stale-IP Resolver', server: '8.8.8.8' },
      ],
      healthEndpoints: ['https://api.revora.io/health'],
      resolverFn: staleTtlResolver,
      healthFetcherFn: jest.fn().mockResolvedValue({ statusCode: 200, healthy: true, responseTimeMs: 10 }),
    });

    printReport(report, false);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[STALE] Stale-TTL Resolver (1.1.1.1)'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[STALE] Stale-IP Resolver (8.8.8.8)'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[PASS] https://api.revora.io/health: HTTP 200'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Overall Health Probe:  PASS'));
  });

  it('prints report with empty health endpoint list (skips health section)', async () => {
    const mockResolverFn = jest.fn().mockResolvedValue({ ip: '1.2.3.4', ttl: 30 });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [{ name: 'Solo Resolver', server: '1.1.1.1' }],
      resolverFn: mockResolverFn,
    });

    printReport(report, false);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[PASS] Solo Resolver (1.1.1.1)'));
    const allCalls = consoleLogSpy.mock.calls.flat().join(' ');
    expect(allCalls).not.toContain('Health Check Probes');
  });

  it('prints JSON format when asJson is true', async () => {
    const mockResolverFn = jest.fn().mockResolvedValue({ ip: '1.2.3.4', ttl: 30 });
    const report = await checkDnsTtlAndHealth({
      domain: 'api.revora.io',
      expectedIp: '1.2.3.4',
      targetMaxTtlSeconds: 60,
      resolvers: [{ name: 'Test Resolver', server: '1.1.1.1' }],
      resolverFn: mockResolverFn,
    });

    printReport(report, true);

    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('"propagationStatus": "COMPLETE"'));
  });
});

describe('runCli', () => {
  let processExitSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PRIMARY_DNS;
    delete process.env.EXPECTED_IP;
    delete process.env.TARGET_TTL;
    delete process.env.PRIMARY_HEALTH_URL;
    delete process.env.SECONDARY_HEALTH_URL;
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      const err: any = new Error(`process.exit:${code}`);
      err.__processExitSentinel = true;
      throw err;
    });
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    processExitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('prints help message when -h flag is passed', async () => {
    process.argv = ['node', 'ttl-check.ts', '-h'];

    await expect(runCli()).rejects.toThrow('process.exit:0');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('DNS TTL & Failover Drill Verification Script'));
  });

  it('prints help message when --help flag (double dash) is passed', async () => {
    process.argv = ['node', 'ttl-check.ts', '--help'];

    await expect(runCli()).rejects.toThrow('process.exit:0');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('executes CLI successfully with custom flags and passes', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    process.argv = [
      'node',
      'ttl-check.ts',
      '--domain',
      'api.revora.io',
      '--expected-ip',
      '1.2.3.4',
      '--target-ttl',
      '60',
      '--health-url',
      `http://127.0.0.1:${port}/health`,
      '--json',
    ];

    const mockResolve4 = jest.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 30 }]);
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    const setServersSpy = jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:0');

    resolverSpy.mockRestore();
    setServersSpy.mockRestore();
    server.close();
  });

  it('uses PRIMARY_HEALTH_URL / SECONDARY_HEALTH_URL env vars when --health-url is omitted', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const localHealth = `http://127.0.0.1:${port}/health`;

    process.argv = ['node', 'ttl-check.ts'];
    process.env.PRIMARY_DNS = 'api.revora.io';
    process.env.EXPECTED_IP = '1.2.3.4';
    process.env.TARGET_TTL = '60';
    process.env.PRIMARY_HEALTH_URL = localHealth;
    process.env.SECONDARY_HEALTH_URL = localHealth;

    const mockResolve4 = jest.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 30 }]);
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    const setServersSpy = jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:0');

    resolverSpy.mockRestore();
    setServersSpy.mockRestore();
    server.close();
  });

  it('uses DEFAULT values for domain/expected-ip/target-ttl when no flags or env vars provided (falls through || chains)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const localHealth = `http://127.0.0.1:${port}/health`;

    process.argv = ['node', 'ttl-check.ts', '--health-url', localHealth, '--health-url', localHealth];

    const mockResolve4 = jest.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 30 }]);
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    const setServersSpy = jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:0');

    resolverSpy.mockRestore();
    setServersSpy.mockRestore();
    server.close();
  });

  it('exits with code 1 via health-only failure (propagation=COMPLETE, but !report.overallHealthy triggers exit)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(503);
      res.end('Service Unavailable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    process.argv = [
      'node',
      'ttl-check.ts',
      '--domain',
      'api.revora.io',
      '--expected-ip',
      '1.2.3.4',
      '--target-ttl',
      '60',
      '--health-url',
      `http://127.0.0.1:${port}/health`,
    ];

    const mockResolve4 = jest.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 30 }]);
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:1');
    resolverSpy.mockRestore();
    server.close();
  });

  it('handles trailing --health-url flag with no value + valid health URL before it (i+1 < args.length true AND false branches)', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const localHealth = `http://127.0.0.1:${port}/health`;

    process.argv = ['node', 'ttl-check.ts', '--domain', 'api.revora.io', '--expected-ip', '1.2.3.4', '--health-url', localHealth, '--health-url'];

    const mockResolve4 = jest.fn().mockRejectedValue(new Error('timeout'));
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:1');
    resolverSpy.mockRestore();
    server.close();
  });

  it('exits with code 1 when resolution fails or health check fails', async () => {
    process.argv = ['node', 'ttl-check.ts'];
    process.env.PRIMARY_DNS = 'api.revora.io';
    process.env.EXPECTED_IP = '1.2.3.4';
    process.env.PRIMARY_HEALTH_URL = 'http://127.0.0.1:59998/health';
    process.env.SECONDARY_HEALTH_URL = 'http://127.0.0.1:59999/health';

    const mockResolve4 = jest.fn().mockRejectedValue(new Error('Resolution failed'));
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    const setServersSpy = jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(runCli()).rejects.toThrow('process.exit:1');

    resolverSpy.mockRestore();
    setServersSpy.mockRestore();
  });

  it('handles CLI fatal errors gracefully (validateInputs throws non-sentinel error)', async () => {
    process.argv = ['node', 'ttl-check.ts', '--domain', 'invalid_domain!'];

    await expect(runCli()).rejects.toThrow('process.exit:1');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('FATAL ERROR'));
  });
});

describe('defaultResolveDns', () => {
  it('resolves IPv4 records successfully via dns Resolver', async () => {
    const mockResolve4 = jest.fn().mockResolvedValue([{ address: '1.2.3.4', ttl: 30 }]);
    const mockSetServers = jest.fn();

    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    const setServersSpy = jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(mockSetServers);

    const result = await defaultResolveDns('8.8.8.8', 'api.revora.io', 2000);
    expect(result).toEqual({ ip: '1.2.3.4', ttl: 30 });
    expect(mockSetServers).toHaveBeenCalledWith(['8.8.8.8']);

    resolverSpy.mockRestore();
    setServersSpy.mockRestore();
  });

  it('rejects when empty records array returned', async () => {
    const mockResolve4 = jest.fn().mockResolvedValue([]);
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(defaultResolveDns('8.8.8.8', 'api.revora.io', 2000)).rejects.toThrow('No A records returned');
    resolverSpy.mockRestore();
  });

  it('rejects when DNS resolution fails with error', async () => {
    const mockResolve4 = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(defaultResolveDns('8.8.8.8', 'api.revora.io', 2000)).rejects.toThrow('ENOTFOUND');
    resolverSpy.mockRestore();
  });

  it('rejects on DNS timeout', async () => {
    const mockResolve4 = jest.fn().mockImplementation(() => new Promise(() => {}));
    const resolverSpy = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(mockResolve4);
    jest.spyOn(Resolver.prototype, 'setServers').mockImplementation(jest.fn());

    await expect(defaultResolveDns('8.8.8.8', 'api.revora.io', 50)).rejects.toThrow('DNS resolution timed out');
    resolverSpy.mockRestore();
  });
});

describe('defaultHealthFetcher', () => {
  it('defaultHealthFetcher handles HTTP requests', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const result = await defaultHealthFetcher(`http://127.0.0.1:${port}/health`, 2000);
    expect(result.statusCode).toBe(200);
    expect(result.healthy).toBe(true);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);

    server.close();
  });

  it('defaultHealthFetcher hits HTTPS transport branch with a non-existent https URL (connection fails but code path is covered)', async () => {
    const result = await defaultHealthFetcher('https://127.0.0.1:55555/health', 50);
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe(0);
  });

  it('defaultHealthFetcher handles connection errors gracefully', async () => {
    const result = await defaultHealthFetcher('http://127.0.0.1:59999/health', 1000);
    expect(result.statusCode).toBe(0);
    expect(result.healthy).toBe(false);
  });

  it('defaultHealthFetcher handles invalid / malformed URLs via the outer try/catch block', async () => {
    const result = await defaultHealthFetcher('this is not a valid url at all', 500);
    expect(result.statusCode).toBe(0);
    expect(result.healthy).toBe(false);
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('defaultHealthFetcher handles empty string URL gracefully', async () => {
    const result = await defaultHealthFetcher('', 500);
    expect(result.statusCode).toBe(0);
    expect(result.healthy).toBe(false);
  });

  it('defaultHealthFetcher handles timeouts gracefully', async () => {
    const server = http.createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end();
      }, 500);
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    const result = await defaultHealthFetcher(`http://127.0.0.1:${port}/health`, 100);
    expect(result.statusCode).toBe(0);
    expect(result.healthy).toBe(false);

    server.close();
  });
});
