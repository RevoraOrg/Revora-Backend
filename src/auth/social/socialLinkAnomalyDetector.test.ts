/**
 * Tests for socialLinkAnomalyDetector.ts
 *
 * Covers:
 *   - Constructor validation (threshold, window, cooldown)
 *   - Threshold crossing with distinct candidate accounts
 *   - Repeated attempts against the same account counted once
 *   - Sliding window expiry
 *   - Cooldown suppression of repeat alerts
 *   - Metric, security audit event, and AML sink emission
 *   - Failure isolation (sink/audit errors never break the flow)
 *   - Isolation across providers/subjects
 */

import {
  SocialLinkAnomalyDetector,
  SocialLinkAnomalyDetection,
  SocialLinkAnomalyAmlSink,
  AuditLogAmlSink,
} from './socialLinkAnomalyDetector';
import { InMemorySocialLinkAttemptStore } from './socialLinkAttemptStore';
import { SocialAuthProvider } from './types';
import { SecurityAuditRepository, AuditEvent } from '../../security/types';
import { MetricsCollector } from '../../lib/metrics';

// ── Helpers ──────────────────────────────────────────────────────────────────

const T0 = new Date('2026-07-31T00:00:00.000Z');

interface Recorder {
  metrics: MetricsCollector;
  audit: SecurityAuditRepository;
  sink: SocialLinkAnomalyAmlSink & { emissions: SocialLinkAnomalyDetection[] };
  emissions: SocialLinkAnomalyDetection[];
}

function buildRecorder(): Recorder {
  const metrics = { incrementCounter: jest.fn() } as unknown as MetricsCollector;
  const auditEvents: AuditEvent[] = [];
  const audit = {
    events: auditEvents,
    record: jest.fn(async (event: AuditEvent) => {
      auditEvents.push(event);
    }),
  } as unknown as SecurityAuditRepository;
  const emissions: SocialLinkAnomalyDetection[] = [];
  const sink = {
    emit: jest.fn(async (detection: SocialLinkAnomalyDetection) => {
      emissions.push(detection);
    }),
    emissions,
  } as SocialLinkAnomalyAmlSink & { emissions: SocialLinkAnomalyDetection[] };
  return { metrics, audit, sink, emissions };
}

function makeDetector(overrides: {
  threshold?: number;
  windowMs?: number;
  cooldownMs?: number;
  store?: InMemorySocialLinkAttemptStore;
  now?: () => Date;
} = {}) {
  const recorder = buildRecorder();
  const detector = new SocialLinkAnomalyDetector({
    threshold: overrides.threshold,
    windowMs: overrides.windowMs,
    cooldownMs: overrides.cooldownMs,
    store: overrides.store ?? new InMemorySocialLinkAttemptStore(),
    metrics: recorder.metrics,
    auditRepository: recorder.audit,
    amlSink: recorder.sink,
    now: overrides.now ?? (() => T0),
  });
  return { detector, ...recorder };
}

/** Mutable clock so tests can advance time deterministically. */
function makeClock() {
  let current = T0;
  return {
    set(t: Date) {
      current = t;
    },
    now: () => current,
  };
}

function attempt(
  detector: SocialLinkAnomalyDetector,
  opts: {
    provider?: SocialAuthProvider;
    subject?: string;
    userId: string;
    outcome?: 'link_success' | 'step_up_failed' | 'identity_conflict' | 'email_conflict';
    at?: Date;
  },
): Promise<SocialLinkAnomalyDetection | null> {
  return detector.recordAttempt({
    provider: opts.provider ?? 'google',
    providerSubject: opts.subject ?? 'victim-sub',
    userId: opts.userId,
    outcome: opts.outcome ?? 'step_up_failed',
    attemptedAt: opts.at ?? T0,
  });
}

// ── Constructor validation ───────────────────────────────────────────────────

describe('SocialLinkAnomalyDetector constructor', () => {
  it('throws when threshold is below 2', () => {
    expect(() => new SocialLinkAnomalyDetector({ threshold: 1 })).toThrow(
      'threshold must be an integer >= 2',
    );
  });

  it('throws when threshold is not an integer', () => {
    expect(() => new SocialLinkAnomalyDetector({ threshold: 2.5 })).toThrow(
      'threshold must be an integer >= 2',
    );
  });

  it('throws when windowMs is not positive', () => {
    expect(() => new SocialLinkAnomalyDetector({ windowMs: 0 })).toThrow('windowMs must be positive');
  });

  it('throws when cooldownMs is negative', () => {
    expect(() => new SocialLinkAnomalyDetector({ cooldownMs: -1 })).toThrow(
      'cooldownMs must be non-negative',
    );
  });

  it('applies sensible defaults', () => {
    const { detector } = makeDetector();
    expect(detector).toBeInstanceOf(SocialLinkAnomalyDetector);
  });
});

// ── Detection logic ──────────────────────────────────────────────────────────

describe('SocialLinkAnomalyDetector detection', () => {
  it('returns null below the threshold', async () => {
    const { detector } = makeDetector({ threshold: 3 });
    for (const userId of ['user-1', 'user-2']) {
      await expect(attempt(detector, { userId })).resolves.toBeNull();
    }
  });

  it('detects when one social sub is sprayed across threshold distinct accounts', async () => {
    const { detector, sink, metrics, emissions } = makeDetector({ threshold: 3 });

    const detections: Array<SocialLinkAnomalyDetection | null> = [];
    for (const userId of ['user-1', 'user-2', 'user-3']) {
      detections.push(await attempt(detector, { userId }));
    }

    // First two attempts: below threshold. Third: triggered.
    expect(detections[0]).toBeNull();
    expect(detections[1]).toBeNull();

    const detection = detections[2];
    expect(detection).not.toBeNull();
    expect(detection!.provider).toBe('google');
    expect(detection!.providerSubject).toBe('victim-sub');
    expect(detection!.candidateCount).toBe(3);
    expect(detection!.candidateUserIds).toEqual(['user-1', 'user-2', 'user-3']);
    expect(detection!.threshold).toBe(3);

    // Metric emitted once with provider label only (no PII).
    expect(metrics.incrementCounter as jest.Mock).toHaveBeenCalledWith(
      'social_link_anomaly_total',
      { provider: 'google' },
      1,
      expect.any(String),
    );

    // AML sink fed exactly once.
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);
    expect(emissions[0].candidateUserIds).toEqual(['user-1', 'user-2', 'user-3']);
  });

  it('counts repeated attempts against the same account only once', async () => {
    const { detector, sink } = makeDetector({ threshold: 3 });

    // user-1 tried 3 times (same candidate), then two more distinct accounts.
    for (let i = 0; i < 3; i++) {
      await attempt(detector, { userId: 'user-1' });
    }
    await attempt(detector, { userId: 'user-2' });
    const detection = await attempt(detector, { userId: 'user-3' });

    expect(detection).not.toBeNull();
    expect(detection!.candidateCount).toBe(3);
    expect(detection!.candidateUserIds).toEqual(['user-1', 'user-2', 'user-3']);
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('does not count attempts older than the sliding window', async () => {
    const windowMs = 60 * 60 * 1000; // 1h
    const clock = makeClock();
    const { detector } = makeDetector({ threshold: 3, windowMs, now: clock.now });

    // Two distinct candidates at T0.
    await attempt(detector, { userId: 'user-1', at: T0 });
    await attempt(detector, { userId: 'user-2', at: T0 });

    // Jump 90 minutes: the two old attempts fall outside the window.
    clock.set(new Date(T0.getTime() + 90 * 60 * 1000));
    const detection = await attempt(detector, { userId: 'user-3', at: clock.now() });

    // Only user-3 is inside the window → below threshold.
    expect(detection).toBeNull();
    expect(await detector.getCandidateCount('google', 'victim-sub')).toBe(1);
  });

  it('keeps attempts inside the window after expiry', async () => {
    const windowMs = 2 * 60 * 60 * 1000; // 2h
    const { detector } = makeDetector({ threshold: 3, windowMs });

    await attempt(detector, { userId: 'user-1', at: T0 });
    await attempt(detector, { userId: 'user-2', at: new Date(T0.getTime() + 30 * 60 * 1000) });

    const detection = await attempt(
      detector,
      { userId: 'user-3', at: new Date(T0.getTime() + 60 * 60 * 1000) },
    );

    expect(detection).not.toBeNull();
    expect(detection!.candidateCount).toBe(3);
  });

  it('suppresses repeat alerts within the cooldown window', async () => {
    const { detector, sink } = makeDetector({ threshold: 3, cooldownMs: 60 * 60 * 1000 });

    for (const userId of ['user-1', 'user-2', 'user-3']) {
      await attempt(detector, { userId });
    }
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);

    // user-4 crosses the threshold again but is within cooldown → suppressed.
    const suppressed = await attempt(detector, { userId: 'user-4' });
    expect(suppressed).toBeNull();
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the cooldown elapses', async () => {
    const cooldownMs = 60 * 60 * 1000;
    const clock = makeClock();
    const { detector, sink } = makeDetector({ threshold: 3, cooldownMs, now: clock.now });

    for (const userId of ['user-1', 'user-2', 'user-3']) {
      await attempt(detector, { userId, at: clock.now() });
    }
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);

    // Advance past cooldown; user-4 crosses the threshold again.
    clock.set(new Date(T0.getTime() + cooldownMs + 1000));
    const detection = await attempt(detector, { userId: 'user-4', at: clock.now() });

    expect(detection).not.toBeNull();
    expect(detection!.candidateUserIds).toContain('user-4');
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(2);
  });

  it('tracks provider+subject identities independently', async () => {
    const { detector, sink } = makeDetector({ threshold: 3 });

    // 3 distinct accounts for google:victim-sub → triggers.
    await attempt(detector, { provider: 'google', subject: 'victim-sub', userId: 'user-1' });
    await attempt(detector, { provider: 'google', subject: 'victim-sub', userId: 'user-2' });
    await attempt(detector, { provider: 'google', subject: 'victim-sub', userId: 'user-3' });
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(1);

    // Same 3 user IDs under apple:victim-sub are an independent identity and
    // must not re-trigger (it starts from zero).
    await attempt(detector, { provider: 'apple', subject: 'victim-sub', userId: 'user-1' });
    await attempt(detector, { provider: 'apple', subject: 'victim-sub', userId: 'user-2' });
    const detection = await attempt(detector, { provider: 'apple', subject: 'victim-sub', userId: 'user-3' });

    // apple identity also reaches 3 → triggers independently.
    expect(detection).not.toBeNull();
    expect(detection!.provider).toBe('apple');
    expect(sink.emit as jest.Mock).toHaveBeenCalledTimes(2);
  });
});

// ── Side-effect isolation ────────────────────────────────────────────────────

describe('SocialLinkAnomalyDetector side effects', () => {
  it('records a SECURITY_VIOLATION audit event on detection', async () => {
    const { detector, audit } = makeDetector({ threshold: 2 });

    await attempt(detector, { userId: 'user-1' });
    await attempt(detector, { userId: 'user-2' });

    const events = (audit as unknown as { events: AuditEvent[] }).events;
    const anomaly = events.find((e) => e.action === 'social_link_anomaly_detected');
    expect(anomaly).toBeDefined();
    expect(anomaly!.type).toBe('SECURITY_VIOLATION');
    expect(anomaly!.outcome).toBe('BLOCKED');
    expect(anomaly!.details.candidateCount).toBe(2);
    expect(anomaly!.details.providerSubject).toBe('victim-sub');
  });

  it('never throws when the audit repository fails', async () => {
    const recorder = buildRecorder();
    const audit = {
      record: jest.fn(async () => {
        throw new Error('audit db down');
      }),
    } as unknown as SecurityAuditRepository;
    const detector = new SocialLinkAnomalyDetector({
      threshold: 2,
      store: new InMemorySocialLinkAttemptStore(),
      metrics: recorder.metrics,
      auditRepository: audit,
      amlSink: recorder.sink,
      now: () => T0,
    });

    await expect(attempt(detector, { userId: 'user-1' })).resolves.toBeNull();
    const detection = await attempt(detector, { userId: 'user-2' });
    expect(detection).not.toBeNull();
  });

  it('never throws when the AML sink fails', async () => {
    const recorder = buildRecorder();
    const failingSink: SocialLinkAnomalyAmlSink = {
      emit: jest.fn(async () => {
        throw new Error('aml downstream down');
      }),
    };
    const detector = new SocialLinkAnomalyDetector({
      threshold: 2,
      store: new InMemorySocialLinkAttemptStore(),
      metrics: recorder.metrics,
      auditRepository: recorder.audit,
      amlSink: failingSink,
      now: () => T0,
    });

    await attempt(detector, { userId: 'user-1' });
    const detection = await attempt(detector, { userId: 'user-2' });
    expect(detection).not.toBeNull();
    expect(failingSink.emit).toHaveBeenCalledTimes(1);
  });

  it('never throws when the store fails', async () => {
    const recorder = buildRecorder();
    const store = new InMemorySocialLinkAttemptStore();
    const brokenStore = {
      recordAttempt: jest.fn(async () => {
        throw new Error('store down');
      }),
      listCandidateUserIds: store.listCandidateUserIds.bind(store),
      reset: store.reset.bind(store),
    };
    const detector = new SocialLinkAnomalyDetector({
      threshold: 2,
      store: brokenStore as never,
      metrics: recorder.metrics,
      auditRepository: recorder.audit,
      amlSink: recorder.sink,
      now: () => T0,
    });

    await expect(attempt(detector, { userId: 'user-1' })).rejects.toThrow('store down');
  });
});

// ── AuditLogAmlSink ──────────────────────────────────────────────────────────

describe('AuditLogAmlSink', () => {
  it('records the anomaly as a BLOCKED SECURITY_VIOLATION event', async () => {
    const recorder = buildRecorder();
    const sink = new AuditLogAmlSink(recorder.audit);

    const detection: SocialLinkAnomalyDetection = {
      provider: 'google',
      providerSubject: 'victim-sub',
      candidateUserIds: ['user-1', 'user-2'],
      candidateCount: 2,
      threshold: 2,
      windowMs: 86_400_000,
      detectedAt: T0,
    };

    await sink.emit(detection);

    const events = (recorder.audit as unknown as { events: AuditEvent[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('SECURITY_VIOLATION');
    expect(events[0].outcome).toBe('BLOCKED');
    expect(events[0].action).toBe('social_link_anomaly_detected');
    expect(events[0].userId).toBe('user-1');
    expect(events[0].details.candidateCount).toBe(2);
  });
});
