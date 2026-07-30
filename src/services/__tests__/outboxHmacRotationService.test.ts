/**
 * Tests for OutboxHmacRotationService (issue #717).
 *
 * Coverage targets (≥ 95% on touched code):
 *   - Normal rotation success
 *   - Dual-secret verification during the overlap window
 *   - Old-secret rejection after the overlap window expires
 *   - KMS failure during rotation
 *   - Audit event emitted with correct fields (no secret leakage)
 *   - Scheduler start/stop lifecycle
 *   - getDualKeyConfig() / signOutboundPayload() integration
 */

import {
  OutboxHmacRotationService,
  LocalKmsClient,
  KmsClient,
  RotationAuditEvent,
  AuditSink,
  OutboxHmacRotationOptions,
} from '../outboxHmacRotationService';
import {
  signPayload,
  verifyWebhookPayloadDualKey,
  signOutboundPayload,
} from '../../lib/webhookSignature';
import { MetricsCollector } from '../../lib/metrics';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockKms(secrets: string[]): KmsClient {
  let idx = 0;
  return {
    generateSecret: jest.fn(async () => {
      if (idx >= secrets.length) throw new Error('KMS exhausted');
      return secrets[idx++];
    }),
  };
}

function makeAuditSink(): { sink: AuditSink; events: RotationAuditEvent[] } {
  const events: RotationAuditEvent[] = [];
  const sink: AuditSink = jest.fn(async (event) => { events.push(event); });
  return { sink, events };
}

function makeService(
  overrides: Partial<OutboxHmacRotationOptions> = {},
  secrets: string[] = ['secret-v1', 'secret-v2', 'secret-v3'],
): {
  svc: OutboxHmacRotationService;
  audit: ReturnType<typeof makeAuditSink>;
  kms: KmsClient;
  metrics: MetricsCollector;
} {
  const audit = makeAuditSink();
  const kms = makeMockKms(secrets);
  const metrics = new MetricsCollector({ enabled: true });
  const svc = new OutboxHmacRotationService({
    kmsClient: kms,
    auditSink: audit.sink,
    metrics,
    overlapWindowMs: 5_000, // 5 seconds for tests
    rotationIntervalMs: 60_000,
    ...overrides,
  });
  return { svc, audit, kms, metrics };
}

beforeEach(() => jest.clearAllMocks());

// ─── LocalKmsClient ───────────────────────────────────────────────────────────

describe('LocalKmsClient', () => {
  it('generates a hex string of at least 64 chars (32 bytes)', async () => {
    const client = new LocalKmsClient();
    const secret = await client.generateSecret();
    expect(secret).toMatch(/^[0-9a-f]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(64);
  });

  it('generates unique secrets on consecutive calls', async () => {
    const client = new LocalKmsClient();
    const s1 = await client.generateSecret();
    const s2 = await client.generateSecret();
    expect(s1).not.toBe(s2);
  });

  it('respects custom byteLength', async () => {
    const client = new LocalKmsClient(16);
    const secret = await client.generateSecret();
    expect(secret.length).toBe(32); // 16 bytes → 32 hex chars
  });
});

// ─── Normal rotation success ──────────────────────────────────────────────────

describe('OutboxHmacRotationService — normal rotation', () => {
  it('throws before any rotation occurs and no initialSecret supplied', () => {
    const { svc } = makeService();
    expect(() => svc.getCurrentSecret()).toThrow(/No secret available/);
  });

  it('exposes initialSecret immediately without a rotate() call', () => {
    const svc = new OutboxHmacRotationService({ initialSecret: 'seed-secret' });
    expect(svc.getCurrentSecret()).toBe('seed-secret');
  });

  it('getCurrentSecret returns new secret after rotate()', async () => {
    const { svc } = makeService();
    await svc.rotate();
    expect(svc.getCurrentSecret()).toBe('secret-v1');
  });

  it('second rotate() demotes previous secret and promotes new one', async () => {
    const { svc } = makeService();
    await svc.rotate(); // current = v1
    await svc.rotate(); // current = v2, previous = v1
    expect(svc.getCurrentSecret()).toBe('secret-v2');
    expect(svc.getPreviousSecret()).toBe('secret-v1');
  });

  it('increments version on each rotation', async () => {
    const { svc, audit } = makeService();
    await svc.rotate();
    await svc.rotate();
    expect(audit.events[0].incomingSecretVersion).toBe('v1');
    expect(audit.events[1].incomingSecretVersion).toBe('v2');
    expect(audit.events[1].outgoingSecretVersion).toBe('v1');
  });
});

// ─── Dual-secret verification during overlap window ──────────────────────────

describe('OutboxHmacRotationService — dual-secret overlap window', () => {
  it('isOverlapWindowActive() is false before first rotation', () => {
    const { svc } = makeService();
    expect(svc.isOverlapWindowActive()).toBe(false);
  });

  it('isOverlapWindowActive() is false after first rotation (no previous yet)', async () => {
    const { svc } = makeService();
    await svc.rotate();
    expect(svc.isOverlapWindowActive()).toBe(false);
  });

  it('isOverlapWindowActive() is true immediately after second rotation', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate();
    await svc.rotate();
    expect(svc.isOverlapWindowActive()).toBe(true);
  });

  it('getOverlapExpiresAt() returns 0 when no overlap is active', async () => {
    const { svc } = makeService();
    await svc.rotate();
    expect(svc.getOverlapExpiresAt()).toBe(0);
  });

  it('getOverlapExpiresAt() returns future epoch ms during active overlap', async () => {
    const before = Date.now();
    const { svc } = makeService({ overlapWindowMs: 10_000 });
    await svc.rotate();
    await svc.rotate();
    const expiresAt = svc.getOverlapExpiresAt();
    expect(expiresAt).toBeGreaterThan(before + 9_000);
    expect(expiresAt).toBeLessThan(before + 11_000);
  });

  it('getDualKeyConfig() returns only current secret when no overlap', async () => {
    const { svc } = makeService();
    await svc.rotate();
    const config = svc.getDualKeyConfig();
    expect(config.secret).toBe('secret-v1');
    expect(config.nextSecret).toBeUndefined();
  });

  it('getDualKeyConfig() includes previous secret during overlap window', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate(); // v1
    await svc.rotate(); // v2 current, v1 previous (overlap active)
    const config = svc.getDualKeyConfig();
    expect(config.secret).toBe('secret-v2');
    expect(config.nextSecret).toBe('secret-v1');
    expect(config.nextSecretExpiry).toBeGreaterThan(Date.now());
  });

  it('verifies signature produced with current key using getDualKeyConfig()', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate();
    await svc.rotate();
    const config = svc.getDualKeyConfig();
    const body = '{"event":"payout.completed"}';
    const ts = Date.now().toString();
    const sig = signPayload(config.secret, body, ts);
    const result = verifyWebhookPayloadDualKey(
      { secret: config.secret, nextSecret: config.nextSecret, nextSecretExpiry: config.nextSecretExpiry },
      `${ts}.${body}`,
      sig,
    );
    expect(result.valid).toBe(true);
    expect(result.verifiedByKey).toBe('current');
  });

  it('verifies signature produced with previous key during overlap window', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate(); // current = v1
    const oldSecret = svc.getCurrentSecret();
    await svc.rotate(); // current = v2, previous = v1
    const config = svc.getDualKeyConfig();

    const body = '{"event":"payout.completed"}';
    const ts = Date.now().toString();
    // Sign with the old (previous) secret
    const sig = signPayload(oldSecret, body, ts);
    const result = verifyWebhookPayloadDualKey(
      { secret: config.secret, nextSecret: config.nextSecret, nextSecretExpiry: config.nextSecretExpiry },
      `${ts}.${body}`,
      sig,
    );
    expect(result.valid).toBe(true);
    expect(result.verifiedByKey).toBe('next');
  });
});

// ─── Old-secret rejection after overlap window expires ───────────────────────

describe('OutboxHmacRotationService — overlap window expiry enforcement', () => {
  it('getPreviousSecret() returns undefined after overlap window expires', async () => {
    jest.useFakeTimers();
    const { svc } = makeService({ overlapWindowMs: 1_000 });
    await svc.rotate();
    await svc.rotate();
    expect(svc.getPreviousSecret()).toBe('secret-v1');

    // Advance time past the overlap window
    jest.advanceTimersByTime(1_001);

    expect(svc.getPreviousSecret()).toBeUndefined();
    jest.useRealTimers();
  });

  it('isOverlapWindowActive() returns false after overlap window expires', async () => {
    jest.useFakeTimers();
    const { svc } = makeService({ overlapWindowMs: 500 });
    await svc.rotate();
    await svc.rotate();
    expect(svc.isOverlapWindowActive()).toBe(true);

    jest.advanceTimersByTime(501);

    expect(svc.isOverlapWindowActive()).toBe(false);
    jest.useRealTimers();
  });

  it('getOverlapExpiresAt() returns 0 after overlap window expires', async () => {
    jest.useFakeTimers();
    const { svc } = makeService({ overlapWindowMs: 500 });
    await svc.rotate();
    await svc.rotate();
    const before = svc.getOverlapExpiresAt();
    expect(before).toBeGreaterThan(0);

    jest.advanceTimersByTime(501);
    expect(svc.getOverlapExpiresAt()).toBe(0);
    jest.useRealTimers();
  });

  it('getDualKeyConfig() drops nextSecret after overlap expires', async () => {
    jest.useFakeTimers();
    const { svc } = makeService({ overlapWindowMs: 500 });
    await svc.rotate();
    await svc.rotate();

    jest.advanceTimersByTime(501);

    const config = svc.getDualKeyConfig();
    expect(config.secret).toBe('secret-v2');
    expect(config.nextSecret).toBeUndefined();
    expect(config.nextSecretExpiry).toBeUndefined();
    jest.useRealTimers();
  });

  it('rejects old-key signature after overlap expires via verifyWebhookPayloadDualKey', async () => {
    jest.useFakeTimers();
    const { svc } = makeService({ overlapWindowMs: 500 });
    await svc.rotate(); // current = v1
    const oldSecret = svc.getCurrentSecret();
    await svc.rotate(); // current = v2, previous = v1

    // Grab the expiry BEFORE advancing time
    const expiryMs = svc.getOverlapExpiresAt();

    // Sign with old key BEFORE expiry
    const body = '{"event":"payout.completed"}';
    const ts = Date.now().toString();
    const sig = signPayload(oldSecret, body, ts);

    // Advance past overlap window
    jest.advanceTimersByTime(501);

    // Now verify with expired config
    const config = svc.getDualKeyConfig();
    const result = verifyWebhookPayloadDualKey(
      { secret: config.secret, nextSecret: oldSecret, nextSecretExpiry: expiryMs },
      `${ts}.${body}`,
      sig,
    );
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
    jest.useRealTimers();
  });
});

// ─── KMS failure during rotation ─────────────────────────────────────────────

describe('OutboxHmacRotationService — KMS failure handling', () => {
  it('rotate() throws when KMS fails', async () => {
    const kms: KmsClient = {
      generateSecret: jest.fn().mockRejectedValue(new Error('KMS unreachable')),
    };
    const svc = new OutboxHmacRotationService({ kmsClient: kms });
    await expect(svc.rotate()).rejects.toThrow('KMS unreachable');
  });

  it('does not change current secret when KMS fails mid-rotation', async () => {
    let callCount = 0;
    const kms: KmsClient = {
      generateSecret: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return 'secret-v1';
        throw new Error('KMS timeout');
      }),
    };
    const { audit } = makeAuditSink();
    const svc = new OutboxHmacRotationService({
      kmsClient: kms,
      auditSink: audit,
      overlapWindowMs: 60_000,
    });

    await svc.rotate(); // succeeds
    expect(svc.getCurrentSecret()).toBe('secret-v1');

    await expect(svc.rotate()).rejects.toThrow('KMS timeout');

    // current must still be v1 — rotation must NOT have partially applied
    expect(svc.getCurrentSecret()).toBe('secret-v1');
  });

  it('audit event is NOT emitted when KMS fails', async () => {
    const kms: KmsClient = {
      generateSecret: jest.fn().mockRejectedValue(new Error('KMS down')),
    };
    const { sink, events } = makeAuditSink();
    const svc = new OutboxHmacRotationService({ kmsClient: kms, auditSink: sink });

    await expect(svc.rotate()).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  it('scheduled rotation logs error and continues scheduling when KMS fails', async () => {
    jest.useFakeTimers();
    let callCount = 0;
    const kms: KmsClient = {
      generateSecret: jest.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return 'secret-v1';
        throw new Error('KMS transient error');
      }),
    };
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new OutboxHmacRotationService({
      kmsClient: kms,
      overlapWindowMs: 5_000,
      rotationIntervalMs: 1_000,
    });

    await svc.start(); // first rotation succeeds
    expect(svc.getCurrentSecret()).toBe('secret-v1');

    // Advance to trigger second (failing) rotation
    await jest.advanceTimersByTimeAsync(1_001);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[OutboxHmacRotationService] Scheduled rotation failed:'),
      expect.any(Error),
    );

    // Service should still be running (scheduling continues after failure)
    expect(svc.getCurrentSecret()).toBe('secret-v1'); // unchanged

    svc.stop();
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });
});

// ─── Audit event fields ───────────────────────────────────────────────────────

describe('OutboxHmacRotationService — audit event', () => {
  it('emits secret.rotation.completed with correct action', async () => {
    const { svc, audit } = makeService();
    await svc.rotate();
    expect(audit.events[0].action).toBe('secret.rotation.completed');
  });

  it('includes rotatedAt as ISO 8601 timestamp', async () => {
    const { svc, audit } = makeService();
    await svc.rotate();
    expect(audit.events[0].rotatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes incomingSecretVersion and outgoingSecretVersion', async () => {
    const { svc, audit } = makeService();
    await svc.rotate(); // v1 in, 'none' out
    await svc.rotate(); // v2 in, v1 out
    expect(audit.events[0].incomingSecretVersion).toBe('v1');
    expect(audit.events[0].outgoingSecretVersion).toBe('none');
    expect(audit.events[1].incomingSecretVersion).toBe('v2');
    expect(audit.events[1].outgoingSecretVersion).toBe('v1');
  });

  it('includes overlapExpiresAtMs as a future epoch ms', async () => {
    const before = Date.now();
    const { svc, audit } = makeService({ overlapWindowMs: 10_000 });
    await svc.rotate();
    await svc.rotate();
    // Second rotation creates overlap
    const event = audit.events[1];
    expect(event.overlapExpiresAtMs).toBeGreaterThan(before + 9_000);
  });

  it('includes overlapWindowMs matching the configured value', async () => {
    const { svc, audit } = makeService({ overlapWindowMs: 7_777 });
    await svc.rotate();
    expect(audit.events[0].overlapWindowMs).toBe(7_777);
  });

  it('includes resource label when configured', async () => {
    const { audit } = makeAuditSink();
    const kms = makeMockKms(['sec-a']);
    const svc = new OutboxHmacRotationService({
      kmsClient: kms,
      auditSink: audit.sink,
      resource: 'outbox-global',
    });
    await svc.rotate();
    expect(audit.events[0].resource).toBe('outbox-global');
  });

  it('does NOT include secret values in audit event', async () => {
    const { svc, audit } = makeService();
    await svc.rotate();
    const event = audit.events[0];
    const eventStr = JSON.stringify(event);
    expect(eventStr).not.toContain('secret-v1');
    expect(eventStr).not.toContain('secret-v2');
    expect(eventStr).not.toContain('secret-v3');
  });

  it('continues rotation even when audit sink throws', async () => {
    const failingSink: AuditSink = jest.fn().mockRejectedValue(new Error('DB write failed'));
    const kms = makeMockKms(['sec-x', 'sec-y']);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const svc = new OutboxHmacRotationService({ kmsClient: kms, auditSink: failingSink });

    // Should NOT throw despite audit failure
    await expect(svc.rotate()).resolves.toBeUndefined();
    expect(svc.getCurrentSecret()).toBe('sec-x');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[OutboxHmacRotationService] Failed to emit audit event:'),
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });
});

// ─── Scheduler lifecycle ──────────────────────────────────────────────────────

describe('OutboxHmacRotationService — scheduler lifecycle', () => {
  it('start() performs immediate rotation when no secret is loaded', async () => {
    const { svc } = makeService();
    await svc.start();
    expect(svc.getCurrentSecret()).toBe('secret-v1');
    svc.stop();
  });

  it('start() is idempotent (no double rotation on repeated calls)', async () => {
    const { svc, kms } = makeService();
    await svc.start();
    await svc.start(); // second call must be no-op
    expect((kms.generateSecret as jest.Mock).mock.calls).toHaveLength(1);
    svc.stop();
  });

  it('start() does not re-rotate when initialSecret already loaded', async () => {
    const { audit } = makeAuditSink();
    const kms = makeMockKms(['sec-new']);
    const svc = new OutboxHmacRotationService({
      kmsClient: kms,
      auditSink: audit.sink,
      initialSecret: 'seed-secret',
    });
    await svc.start(); // should NOT rotate since secret is already set
    expect((kms.generateSecret as jest.Mock)).not.toHaveBeenCalled();
    expect(svc.getCurrentSecret()).toBe('seed-secret');
    svc.stop();
  });

  it('stop() prevents further scheduled rotations', async () => {
    jest.useFakeTimers();
    const { svc, kms } = makeService({ rotationIntervalMs: 1_000 });
    await svc.start(); // 1 rotation
    svc.stop();
    await jest.advanceTimersByTimeAsync(5_000);
    // Only the initial rotation should have been called
    expect((kms.generateSecret as jest.Mock).mock.calls).toHaveLength(1);
    jest.useRealTimers();
  });

  it('schedules subsequent rotations on interval', async () => {
    jest.useFakeTimers();
    const { svc, kms } = makeService({
      rotationIntervalMs: 1_000,
    }, ['s1', 's2', 's3', 's4']);
    await svc.start();
    await jest.advanceTimersByTimeAsync(2_500);
    // start=1, +1s=2, +2s=3 = 3 total rotations
    expect((kms.generateSecret as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2);
    svc.stop();
    jest.useRealTimers();
  });
});

// ─── Metrics emission ─────────────────────────────────────────────────────────

describe('OutboxHmacRotationService — metrics', () => {
  it('increments outbox_hmac_rotations_total counter on each rotation', async () => {
    const { svc, metrics } = makeService({ resource: 'test-resource' });
    const spy = jest.spyOn(metrics, 'incrementCounter');
    await svc.rotate();
    await svc.rotate();
    const rotationCalls = spy.mock.calls.filter(([name]) => name === 'outbox_hmac_rotations_total');
    expect(rotationCalls).toHaveLength(2);
    expect(rotationCalls[0][1]).toEqual({ resource: 'test-resource' });
  });

  it('uses global resource label when none configured', async () => {
    const { svc, metrics } = makeService();
    const spy = jest.spyOn(metrics, 'incrementCounter');
    await svc.rotate();
    const call = spy.mock.calls.find(([name]) => name === 'outbox_hmac_rotations_total');
    expect(call?.[1]).toEqual({ resource: 'global' });
  });

  it('silently ignores metrics errors', async () => {
    const metrics = new MetricsCollector({ enabled: false });
    const spy = jest.spyOn(metrics, 'incrementCounter').mockImplementation(() => {
      throw new Error('metrics unavailable');
    });
    const kms = makeMockKms(['sec-m']);
    const svc = new OutboxHmacRotationService({ kmsClient: kms, metrics });
    // Must not throw even if metrics.incrementCounter throws
    await expect(svc.rotate()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// ─── signOutboundPayload integration ─────────────────────────────────────────

describe('signOutboundPayload — integration with rotation service', () => {
  it('signs with current key and reports overlap inactive when no previous', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate();
    const config = svc.getDualKeyConfig();
    const body = '{"event":"offering.created"}';
    const ts = Date.now().toString();

    const result = signOutboundPayload(
      { currentSecret: config.secret, previousSecret: config.nextSecret, overlapExpiresAtMs: config.nextSecretExpiry },
      body,
      ts,
    );

    expect(result.usedKey).toBe('current');
    expect(result.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(result.overlapWindowActive).toBe(false);
    expect(result.overlapExpiresAtMs).toBe(0);
  });

  it('signs with current key and reports overlap active during window', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate();
    await svc.rotate();
    const config = svc.getDualKeyConfig();
    const body = '{"event":"payout.completed"}';
    const ts = Date.now().toString();

    const result = signOutboundPayload(
      { currentSecret: config.secret, previousSecret: config.nextSecret, overlapExpiresAtMs: config.nextSecretExpiry },
      body,
      ts,
    );

    expect(result.usedKey).toBe('current');
    expect(result.overlapWindowActive).toBe(true);
    expect(result.overlapExpiresAtMs).toBeGreaterThan(Date.now());
  });

  it('produced signature is verifiable with current key', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.rotate();
    await svc.rotate();
    const config = svc.getDualKeyConfig();
    const body = '{"event":"distribution.completed"}';
    const ts = Date.now().toString();

    const { signature } = signOutboundPayload(
      { currentSecret: config.secret, previousSecret: config.nextSecret, overlapExpiresAtMs: config.nextSecretExpiry },
      body,
      ts,
    );

    const result = verifyWebhookPayloadDualKey(
      { secret: config.secret, nextSecret: config.nextSecret, nextSecretExpiry: config.nextSecretExpiry },
      `${ts}.${body}`,
      signature,
    );
    expect(result.valid).toBe(true);
    expect(result.verifiedByKey).toBe('current');
  });

  it('overlapWindowActive is false when overlapExpiresAtMs is in the past', () => {
    const result = signOutboundPayload(
      { currentSecret: 'current', previousSecret: 'old', overlapExpiresAtMs: Date.now() - 1_000 },
      'body',
      'ts',
    );
    expect(result.overlapWindowActive).toBe(false);
    expect(result.overlapExpiresAtMs).toBe(0);
  });

  it('overlapWindowActive is false when no previousSecret provided', () => {
    const result = signOutboundPayload({ currentSecret: 'current' }, 'body', 'ts');
    expect(result.overlapWindowActive).toBe(false);
    expect(result.overlapExpiresAtMs).toBe(0);
  });
});

// ─── makeWebhookDispatchFn with rotation service ──────────────────────────────

import { makeWebhookDispatchFn } from '../outboxDispatcher';
import { OutboxRow } from '../../db/repositories/outboxRepository';
import { WebhookEventType } from '../webhookService';

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'row-1',
    event_id: 'evt-uuid-stable',
    event_type: WebhookEventType.PAYOUT_COMPLETED,
    payload: { investor_id: 'inv-1' },
    status: 'pending',
    attempts: 0,
    available_at: new Date(),
    created_at: new Date('2025-01-01T00:00:00Z'),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('makeWebhookDispatchFn with OutboxHmacRotationService', () => {
  it('enriches payload with __signing metadata when rotation service provided', async () => {
    const { svc } = makeService({ overlapWindowMs: 60_000 });
    await svc.start();

    const processDelivery = jest.fn().mockResolvedValue(true);
    const listActiveByEvent = jest.fn().mockResolvedValue([{ url: 'https://example.com/hook' }]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent, svc);
    await fn(makeRow());

    const call = processDelivery.mock.calls[0];
    const enriched = call[1] as any;
    expect(enriched.__signing).toBeDefined();
    expect(enriched.__signing.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(enriched.__signing.timestamp).toBeDefined();
    expect(typeof enriched.__signing.overlapWindowActive).toBe('boolean');

    svc.stop();
  });

  it('falls back to legacy path (no __signing) when no rotation service provided', async () => {
    const processDelivery = jest.fn().mockResolvedValue(true);
    const listActiveByEvent = jest.fn().mockResolvedValue([{ url: 'https://example.com/hook' }]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent);
    await fn(makeRow());

    const call = processDelivery.mock.calls[0];
    const payload = call[1] as any;
    expect(payload.__signing).toBeUndefined();
  });

  it('returns true when no endpoints subscribed (rotation service present)', async () => {
    const { svc } = makeService();
    await svc.start();

    const processDelivery = jest.fn().mockResolvedValue(true);
    const listActiveByEvent = jest.fn().mockResolvedValue([]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent, svc);
    const result = await fn(makeRow());
    expect(result).toBe(true);
    expect(processDelivery).not.toHaveBeenCalled();

    svc.stop();
  });

  it('returns false if any delivery fails (rotation service present)', async () => {
    const { svc } = makeService();
    await svc.start();

    const processDelivery = jest.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const listActiveByEvent = jest.fn().mockResolvedValue([
      { url: 'https://a.example.com/hook' },
      { url: 'https://b.example.com/hook' },
    ]);

    const fn = makeWebhookDispatchFn(processDelivery, listActiveByEvent, svc);
    const result = await fn(makeRow());
    expect(result).toBe(false);

    svc.stop();
  });
});
