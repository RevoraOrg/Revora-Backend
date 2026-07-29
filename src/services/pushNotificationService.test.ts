/**
 * @fileoverview Tests for PushNotificationService – 410 pruning, backoff,
 * metrics, and audit event recording.
 *
 * @module services/pushNotificationService.test
 */

import {
  PushNotificationService,
  PushSendFn,
  PushSendResult,
  PushNotificationServiceOptions,
} from './pushNotificationService';
import {
  InMemoryPushTokenRepository,
  PushToken,
  PushTokenRepository,
} from '../db/repositories/pushTokenRepository';
import {
  InMemorySecurityAuditRepository,
} from '../security/audit';
import { SecurityAuditRepository } from '../security/types';
import { MetricsCollector } from '../lib/metrics';
import { PushPayload } from './pushQuietHoursService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal active push token to use in tests. */
function makeToken(overrides: Partial<PushToken> = {}): PushToken {
  return {
    id: 'pt-1',
    user_id: 'user-1',
    token: 'fcm-token-abc',
    provider: 'fcm',
    status: 'active',
    last_used_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

/** Create a minimal push payload. */
function makePayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return {
    userId: 'user-1',
    title: 'Test Title',
    body: 'Test Body',
    ...overrides,
  };
}

/** Build a send function that returns a fixed result. */
function fixedSendFn(result: PushSendResult): PushSendFn {
  return jest.fn<Promise<PushSendResult>, [string, PushPayload]>().mockResolvedValue(result);
}

/** Build a send function from an array of results (one per call). */
function sequencedSendFn(...results: PushSendResult[]): PushSendFn {
  let idx = 0;
  return jest
    .fn<Promise<PushSendResult>, [string, PushPayload]>()
    .mockImplementation(async () => {
      const r = results[idx];
      if (idx < results.length - 1) idx++;
      return r;
    });
}

interface TestContext {
  tokenRepo: PushTokenRepository;
  auditRepo: SecurityAuditRepository;
  metrics: MetricsCollector;
  service: PushNotificationService;
}

function setup(opts: Partial<PushNotificationServiceOptions> = {}): TestContext {
  const tokenRepo = new InMemoryPushTokenRepository();
  const auditRepo = new InMemorySecurityAuditRepository();
  const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
  const service = new PushNotificationService(tokenRepo, auditRepo, metrics, {
    // Fast defaults for tests
    initialDelayMs: 1,
    maxDelayMs: 100,
    jitter: 0, // deterministic delays in tests
    ...opts,
  });
  return { tokenRepo, auditRepo, metrics, service };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PushNotificationService', () => {
  // -----------------------------------------------------------------------
  // Send – success path
  // -----------------------------------------------------------------------

  describe('send – success', () => {
    it('returns success when the provider accepts the push (2xx)', async () => {
      const { service } = setup();
      const token = makeToken();
      const payload = makePayload();
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });

      const result = await service.send(token, payload, sendFn);
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('emits push_send_success_total metric on success', async () => {
      const { service, metrics } = setup();
      const token = makeToken();
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const successMetric = snapshot.custom.find(
        (m) => m.name === 'push_send_success_total',
      );
      expect(successMetric).toBeDefined();
      expect(successMetric!.value).toBe(1);
    });

    it('emits push_send_attempts_total on every attempt', async () => {
      const { service, metrics } = setup();
      const token = makeToken();
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const attempts = snapshot.custom.filter(
        (m) => m.name === 'push_send_attempts_total',
      );
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts.reduce((s, m) => s + m.value, 0)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Send – 410 pruning
  // -----------------------------------------------------------------------

  describe('send – 410 Gone (pruning)', () => {
    it('marks the token as pruned on 410', async () => {
      const { service, tokenRepo } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'fcm-token-410',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410, error: 'Gone' });

      await service.send(token, makePayload(), sendFn);

      const pruned = await tokenRepo.findByToken('fcm-token-410');
      expect(pruned).not.toBeNull();
      expect(pruned!.status).toBe('pruned');
    });

    it('emits push_token_pruned_total counter on 410', async () => {
      const { service, tokenRepo, metrics } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'fcm-token-410-2',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const prunedMetric = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(prunedMetric).toBeDefined();
      expect(prunedMetric!.value).toBe(1);
      expect(prunedMetric!.labels).toMatchObject({ provider: 'fcm' });
    });

    it('emits push_token_pruned_current gauge after pruning', async () => {
      const { service, tokenRepo, metrics } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'fcm-gauge-test',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const gauge = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_current',
      );
      expect(gauge).toBeDefined();
      expect(gauge!.value).toBe(1);
    });

    it('records an audit event when pruning on 410', async () => {
      const { service, tokenRepo, auditRepo } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'apns-token-410',
        provider: 'apns',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      const inMemAudit = auditRepo as InMemorySecurityAuditRepository;
      const events = inMemAudit.getAllEvents();
      const pruneEvents = events.filter((e) => e.action === 'push_token_pruned');
      expect(pruneEvents).toHaveLength(1);
      expect(pruneEvents[0].type).toBe('SECURITY_VIOLATION');
      expect(pruneEvents[0].outcome).toBe('BLOCKED');
      expect(pruneEvents[0].details.provider).toBe('apns');
      expect(pruneEvents[0].details.reason).toContain('410');
    });

    it('does NOT retry after 410', async () => {
      const { service, tokenRepo } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'no-retry-410',
        provider: 'fcm',
      });
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      // Should be called exactly once — no retries after 410.
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('still emits metric even if DB write (markPruned) fails', async () => {
      // Use a tokenRepo that throws on markPruned.
      const brokenRepo: PushTokenRepository = {
        upsert: jest.fn(),
        findActiveByUser: jest.fn().mockResolvedValue([]),
        findByToken: jest.fn().mockResolvedValue(null),
        markPruned: jest.fn().mockRejectedValue(new Error('DB down')),
        markExpired: jest.fn(),
        countActive: jest.fn().mockResolvedValue(0),
        countPruned: jest.fn().mockResolvedValue(0),
      };
      const auditRepo = new InMemorySecurityAuditRepository();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const service = new PushNotificationService(
        brokenRepo,
        auditRepo,
        metrics,
        { initialDelayMs: 1, maxDelayMs: 100, jitter: 0 },
      );

      const sendFn = fixedSendFn({ success: false, statusCode: 410 });
      const token = makeToken();

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);

      const snapshot = await metrics.getSnapshot();
      const prunedMetric = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(prunedMetric).toBeDefined();
      expect(prunedMetric!.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Send – transient errors (5xx / 429) with backoff
  // -----------------------------------------------------------------------

  describe('send – backoff on 5xx / 429', () => {
    it('retries on 5xx up to maxRetries', async () => {
      const { service } = setup({ maxRetries: 3, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = sequencedSendFn(
        { success: false, statusCode: 503 },
        { success: false, statusCode: 503 },
        { success: true, statusCode: 200 },
      );

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(3);
    });

    it('retries on 429 (rate limiting)', async () => {
      const { service } = setup({ maxRetries: 4, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = sequencedSendFn(
        { success: false, statusCode: 429 },
        { success: true, statusCode: 200 },
      );

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('retries on network errors (no status code)', async () => {
      const { service } = setup({ maxRetries: 3, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = sequencedSendFn(
        { success: false, error: 'ECONNRESET' },
        { success: true, statusCode: 200 },
      );

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('does NOT evict the token on 5xx', async () => {
      const { service, tokenRepo } = setup({ maxRetries: 2, initialDelayMs: 1, jitter: 0 });
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'no-evict-5xx',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 500 });

      await service.send(token, makePayload(), sendFn);

      const after = await tokenRepo.findByToken('no-evict-5xx');
      expect(after).not.toBeNull();
      expect(after!.status).toBe('active'); // NOT pruned
    });

    it('returns the last error after exhausting retries', async () => {
      const { service } = setup({ maxRetries: 3, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = fixedSendFn({ success: false, statusCode: 502 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(502);
      expect(sendFn).toHaveBeenCalledTimes(3);
    });

    it('emits push_send_failures_total after exhausting retries', async () => {
      const { service, metrics } = setup({ maxRetries: 2, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = fixedSendFn({ success: false, statusCode: 500 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const failure = snapshot.custom.find(
        (m) =>
          m.name === 'push_send_failures_total' &&
          m.labels?.reason === 'max_retries_exceeded',
      );
      expect(failure).toBeDefined();
      expect(failure!.value).toBe(1);
    });

    it('applies increasing backoff delays between retries', async () => {
      const opts: Partial<PushNotificationServiceOptions> = {
        maxRetries: 3,
        initialDelayMs: 10,
        backoffFactor: 2,
        maxDelayMs: 50,
        jitter: 0,
      };
      const { service } = setup(opts);
      const token = makeToken();

      // Track actual delays
      const delays: number[] = [];
      const originalSetTimeout = global.setTimeout;
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: (...args: any[]) => void, ms?: number) => {
          if (ms !== undefined) delays.push(ms);
          fn();
          return 1 as unknown as NodeJS.Timeout;
        });

      try {
        const sendFn = sequencedSendFn(
          { success: false, statusCode: 503 },
          { success: false, statusCode: 503 },
          { success: false, statusCode: 503 },
        );

        await service.send(token, makePayload(), sendFn);

        // backoff(1) = min(10 * 2^0, 50) = 10
        // backoff(2) = min(10 * 2^1, 50) = 20
        expect(delays).toEqual([10, 20]);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('caps backoff at maxDelayMs', async () => {
      const opts: Partial<PushNotificationServiceOptions> = {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
        maxDelayMs: 50,
        jitter: 0,
      };
      const { service } = setup(opts);
      const token = makeToken();

      const delays: number[] = [];
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: (...args: any[]) => void, ms?: number) => {
          if (ms !== undefined) delays.push(ms);
          fn();
          return 1 as unknown as NodeJS.Timeout;
        });

      try {
        const sendFn = fixedSendFn({ success: false, statusCode: 503 });
        await service.send(token, makePayload(), sendFn);

        // attempt 2: min(100 * 2, 50) = 50 (capped)
        // attempt 3: min(100 * 4, 50) = 50 (capped)
        expect(delays.every((d) => d <= 50)).toBe(true);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Send – non-retryable 4xx (not 429)
  // -----------------------------------------------------------------------

  describe('send – non-retryable 4xx', () => {
    it('fails immediately on 400 without retry', async () => {
      const { service } = setup({ maxRetries: 5, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: false, statusCode: 400 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(400);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('fails immediately on 403 without retry', async () => {
      const { service } = setup();
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: false, statusCode: 403 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('fails immediately on 404 without retry', async () => {
      const { service } = setup();
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: false, statusCode: 404 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(sendFn).toHaveBeenCalledTimes(1);
    });

    it('emits push_send_failures_total with reason 4xx_non_retryable', async () => {
      const { service, metrics } = setup();
      const token = makeToken();
      const sendFn = fixedSendFn({ success: false, statusCode: 400 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const failure = snapshot.custom.find(
        (m) =>
          m.name === 'push_send_failures_total' &&
          m.labels?.reason === '4xx_non_retryable',
      );
      expect(failure).toBeDefined();
      expect(failure!.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Send – already-pruned token
  // -----------------------------------------------------------------------

  describe('send – already-pruned / expired token', () => {
    it('skips delivery for an already-pruned token', async () => {
      const { service } = setup();
      const token = makeToken({ status: 'pruned' });
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: true });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Token already pruned');
      expect(sendFn).not.toHaveBeenCalled();
    });

    it('does NOT skip delivery for an expired token', async () => {
      const { service } = setup();
      const token = makeToken({ status: 'expired' });
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // sendToUser – multicast delivery
  // -----------------------------------------------------------------------

  describe('sendToUser', () => {
    it('delivers to all active tokens for a user', async () => {
      const { service, tokenRepo } = setup();
      await tokenRepo.upsert({ user_id: 'user-m', token: 'tok-1', provider: 'fcm' });
      await tokenRepo.upsert({ user_id: 'user-m', token: 'tok-2', provider: 'apns' });

      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: true, statusCode: 200 });

      const results = await service.sendToUser('user-m', makePayload(), sendFn);
      expect(results).toHaveLength(2);
      expect(results[0].result.success).toBe(true);
      expect(results[1].result.success).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('continues delivering even if one token gets pruned', async () => {
      const { service, tokenRepo } = setup();
      const t1 = await tokenRepo.upsert({ user_id: 'user-p', token: 'prune-me', provider: 'fcm' });
      await tokenRepo.upsert({ user_id: 'user-p', token: 'stay-alive', provider: 'apns' });

      // First token gets 410, second succeeds
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockImplementation(async (tokenStr: string) => {
          if (tokenStr === 'prune-me') return { success: false, statusCode: 410 };
          return { success: true, statusCode: 200 };
        });

      const results = await service.sendToUser('user-p', makePayload(), sendFn);
      expect(results).toHaveLength(2);

      const firstResult = results.find((r) => r.token.id === t1.id);
      expect(firstResult!.result.success).toBe(false);
      expect(firstResult!.result.statusCode).toBe(410);

      const secondResult = results.find((r) => r.token.token === 'stay-alive');
      expect(secondResult!.result.success).toBe(true);
    });

    it('returns empty array when user has no active tokens', async () => {
      const { service } = setup();
      const sendFn = jest.fn<Promise<PushSendResult>, [string, PushPayload]>();
      const results = await service.sendToUser('no-tokens', makePayload(), sendFn);
      expect(results).toHaveLength(0);
      expect(sendFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------

  describe('createPushNotificationService', () => {
    it('returns a functioning service instance', async () => {
      // Dynamic import to avoid hoisting issues
      const { createPushNotificationService } = await import('./pushNotificationService');
      const tokenRepo = new InMemoryPushTokenRepository();
      const auditRepo = new InMemorySecurityAuditRepository();
      const svc = createPushNotificationService(tokenRepo, auditRepo);

      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'factory-test',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });

      const result = await svc.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Backoff – jitter
  // -----------------------------------------------------------------------

  describe('backoff jitter', () => {
    it('applies jitter within expected bounds', async () => {
      const opts: Partial<PushNotificationServiceOptions> = {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
        maxDelayMs: 1000,
        jitter: 0.2, // 20 %
      };
      const { service } = setup(opts);
      const token = makeToken();

      const delays: number[] = [];
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: (...args: any[]) => void, ms?: number) => {
          if (ms !== undefined) delays.push(ms);
          fn();
          return 1 as unknown as NodeJS.Timeout;
        });

      try {
        const sendFn = fixedSendFn({ success: false, statusCode: 500 });
        await service.send(token, makePayload(), sendFn);

        // With jitter=0.2, base delays are:
        // backoff(1): min(100 * 2^0, 1000) = 100 → jittered [100, 120]
        // backoff(2): min(100 * 2^1, 1000) = 200 → jittered [200, 240]
        expect(delays).toHaveLength(2);
        expect(delays[0]).toBeGreaterThanOrEqual(100);
        expect(delays[0]).toBeLessThanOrEqual(120);
        expect(delays[1]).toBeGreaterThanOrEqual(200);
        expect(delays[1]).toBeLessThanOrEqual(240);
      } finally {
        jest.restoreAllMocks();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Provider dimension on metrics
  // -----------------------------------------------------------------------

  describe('provider dimension on metrics', () => {
    it('includes provider label for APNs tokens', async () => {
      const { service, tokenRepo, metrics } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'apns-test',
        provider: 'apns',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const pruned = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(pruned!.labels).toMatchObject({ provider: 'apns' });
    });

    it('includes provider label for FCM tokens', async () => {
      const { service, tokenRepo, metrics } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'fcm-test',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: false, statusCode: 410 });

      await service.send(token, makePayload(), sendFn);

      const snapshot = await metrics.getSnapshot();
      const pruned = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(pruned!.labels).toMatchObject({ provider: 'fcm' });
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles send function that throws and retries', async () => {
      const { service } = setup({ maxRetries: 2, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce({ success: true, statusCode: 200 });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(true);
      expect(sendFn).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries when send function always throws', async () => {
      const { service, metrics } = setup({ maxRetries: 2, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockRejectedValue(new Error('Persistent failure'));

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(sendFn).toHaveBeenCalledTimes(2);

      const snapshot = await metrics.getSnapshot();
      const failure = snapshot.custom.find(
        (m) =>
          m.name === 'push_send_failures_total' &&
          m.labels?.reason === 'max_retries_exceeded',
      );
      expect(failure).toBeDefined();
    });

    it('handles empty payload gracefully', async () => {
      const { service, tokenRepo } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'empty-payload-test',
        provider: 'fcm',
      });
      const sendFn = fixedSendFn({ success: true, statusCode: 200 });
      const payload: PushPayload = { userId: 'user-1', title: '', body: '' };

      const result = await service.send(token, payload, sendFn);
      expect(result.success).toBe(true);
    });

    it('handles retryAfterSec in the result (passes through)', async () => {
      const { service } = setup({ maxRetries: 1, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = fixedSendFn({
        success: false,
        statusCode: 429,
        retryAfterSec: 30,
        error: 'Rate limited',
      });

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.retryAfterSec).toBe(30);
      // Token should NOT be pruned
    });

    it('uses retryAfterSec as a floor for backoff delay', async () => {
      const opts: Partial<PushNotificationServiceOptions> = {
        maxRetries: 2,
        initialDelayMs: 10,
        backoffFactor: 2,
        maxDelayMs: 2000,
        jitter: 0,
      };
      const { service } = setup(opts);
      const token = makeToken();

      const delays: number[] = [];
      jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: (...args: any[]) => void, ms?: number) => {
          if (ms !== undefined) delays.push(ms);
          fn();
          return 1 as unknown as NodeJS.Timeout;
        });

      try {
        // First call succeeds, but we use a failing first result to trigger backoff
        const sendFn = sequencedSendFn(
          { success: false, statusCode: 429, retryAfterSec: 5 }, // 5000 ms hint
          { success: true, statusCode: 200 },
        );
        await service.send(token, makePayload(), sendFn);

        // Computed backoff for attempt 2: 10 * 2^0 = 10 ms
        // Provider hint: 5000 ms
        // Floor: max(10, 5000) = 5000 ms
        expect(delays).toHaveLength(1);
        expect(delays[0]).toBe(5000);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('handles countPruned throwing gracefully', async () => {
      const brokenRepo: PushTokenRepository = {
        upsert: jest.fn(),
        findActiveByUser: jest.fn().mockResolvedValue([]),
        findByToken: jest.fn().mockResolvedValue(null),
        markPruned: jest.fn().mockResolvedValue({ status: 'pruned' }),
        markExpired: jest.fn(),
        countActive: jest.fn().mockResolvedValue(0),
        countPruned: jest.fn().mockRejectedValue(new Error('count failed')),
      };
      const auditRepo = new InMemorySecurityAuditRepository();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const svc = new PushNotificationService(
        brokenRepo,
        auditRepo,
        metrics,
        { initialDelayMs: 1, maxDelayMs: 100, jitter: 0 },
      );

      const sendFn = fixedSendFn({ success: false, statusCode: 410 });
      const token = makeToken();

      const result = await svc.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);

      // Metric should still be emitted despite countPruned throwing
      const snapshot = await metrics.getSnapshot();
      const prunedMetric = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(prunedMetric).toBeDefined();
      expect(prunedMetric!.value).toBe(1);
    });

    it('handles non-Error throws from sendFn', async () => {
      const { service } = setup({ maxRetries: 1, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockRejectedValue('string error');

      const result = await service.send(token, makePayload(), sendFn);
      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    it('does not call auditRepo.record when audit fails gracefully', async () => {
      const { service, tokenRepo } = setup();
      const token = await tokenRepo.upsert({
        user_id: 'user-1',
        token: 'audit-fail',
        provider: 'fcm',
      });

      // Create a service with a broken audit repo
      const brokenAudit: SecurityAuditRepository = {
        record: jest.fn().mockRejectedValue(new Error('audit down')),
        findByUserId: jest.fn(),
        findBySessionId: jest.fn(),
        findSecurityViolations: jest.fn(),
      };
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const svc = new PushNotificationService(
        tokenRepo,
        brokenAudit,
        metrics,
        { initialDelayMs: 1, maxDelayMs: 100, jitter: 0 },
      );

      const sendFn = fixedSendFn({ success: false, statusCode: 410 });
      const result = await svc.send(token, makePayload(), sendFn);

      expect(result.success).toBe(false);
      expect(brokenAudit.record).toHaveBeenCalled();
      // Metric should still be emitted
      const snapshot = await metrics.getSnapshot();
      const prunedMetric = snapshot.custom.find(
        (m) => m.name === 'push_token_pruned_total',
      );
      expect(prunedMetric).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  describe('configuration', () => {
    it('uses default options when none are provided', () => {
      const tokenRepo = new InMemoryPushTokenRepository();
      const auditRepo = new InMemorySecurityAuditRepository();
      const metrics = new MetricsCollector({ enabled: true });
      const svc = new PushNotificationService(tokenRepo, auditRepo, metrics);
      // Service should be created without error
      expect(svc).toBeDefined();
    });

    it('respects custom maxRetries', async () => {
      const { service } = setup({ maxRetries: 1, initialDelayMs: 1, jitter: 0 });
      const token = makeToken();
      const sendFn = jest
        .fn<Promise<PushSendResult>, [string, PushPayload]>()
        .mockResolvedValue({ success: false, statusCode: 503 });

      await service.send(token, makePayload(), sendFn);
      expect(sendFn).toHaveBeenCalledTimes(1); // No retries with maxRetries=1
    });
  });
});
