"""
Event-loop lag monitor with sampling profile and capacity alerts.

Measures scheduling delay (time between intended and actual execution)
and raises alerts when lag exceeds configured thresholds.
"""
import time
import threading
import logging
from dataclasses import dataclass, field
from collections import deque
from typing import Optional, Callable

logger = logging.getLogger(__name__)


@dataclass
class LagSample:
    """A single lag measurement."""
    timestamp: float
    intended_at: float
    actual_at: float
    lag_ms: float

    @property
    def lag_seconds(self) -> float:
        return self.lag_ms / 1000.0


@dataclass
class SamplingProfile:
    """Configuration for lag sampling behaviour."""
    window_size: int = 100          # Max samples to retain
    sample_interval_s: float = 1.0  # How often to sample (seconds)
    alert_threshold_ms: float = 100.0  # Lag threshold for warning
    critical_threshold_ms: float = 500.0  # Lag threshold for critical
    saturation_threshold_ms: float = 1000.0  # Lag threshold for saturation
    max_consecutive_degraded: int = 5  # Consecutive high-lag samples before alert


@dataclass
class LagStats:
    """Aggregated statistics from lag samples."""
    count: int = 0
    min_ms: float = 0.0
    max_ms: float = 0.0
    avg_ms: float = 0.0
    p50_ms: float = 0.0
    p95_ms: float = 0.0
    p99_ms: float = 0.0
    degraded_count: int = 0
    critical_count: int = 0
    saturation_count: int = 0


class EventLoopLagMonitor:
    """Monitors event-loop lag with configurable sampling and alerting.

    Usage::

        monitor = EventLoopLagMonitor(profile=SamplingProfile())
        monitor.start()

        # ... in your event loop iteration:
        monitor.record()

        # Check stats periodically:
        stats = monitor.get_stats()
        if stats.p95_ms > 100:
            logger.warning("Event loop experiencing lag: p95=%.1fms", stats.p95_ms)
    """

    def __init__(
        self,
        profile: Optional[SamplingProfile] = None,
        on_warning: Optional[Callable[["LagStats"], None]] = None,
        on_critical: Optional[Callable[["LagStats"], None]] = None,
        on_saturation: Optional[Callable[["LagStats"], None]] = None,
    ):
        self.profile = profile or SamplingProfile()
        self._samples: deque[LagSample] = deque(maxlen=self.profile.window_size)
        self._last_sample_at: float = 0.0
        self._consecutive_degraded: int = 0
        self._running: bool = False
        self._lock = threading.Lock()
        self._on_warning = on_warning
        self._on_critical = on_critical
        self._on_saturation = on_saturation

    def start(self) -> None:
        """Begin monitoring (clears any previous samples)."""
        with self._lock:
            self._running = True
            self._samples.clear()
            self._consecutive_degraded = 0
            self._last_sample_at = time.monotonic()

    def stop(self) -> None:
        """Stop monitoring."""
        with self._lock:
            self._running = False

    def record(self, intended_at: Optional[float] = None) -> Optional[LagSample]:
        """Record a lag measurement.

        Call this from your event loop iteration. Pass ``intended_at``
        when you know the time the iteration *should* have started;
        otherwise the time since the last ``record()`` call is used.
        """
        now = time.monotonic()
        with self._lock:
            if not self._running:
                return None

            if intended_at is None:
                intended_at = self._last_sample_at + self.profile.sample_interval_s
                if intended_at > now:
                    intended_at = now

            lag = (now - intended_at) * 1000.0  # ms
            sample = LagSample(
                timestamp=now,
                intended_at=intended_at,
                actual_at=now,
                lag_ms=max(0.0, lag),
            )
            self._samples.append(sample)
            self._last_sample_at = now

            self._evaluate_alerts(sample)
            return sample

    def _evaluate_alerts(self, sample: LagSample) -> None:
        """Check thresholds and fire callbacks."""
        if sample.lag_ms > self.profile.alert_threshold_ms:
            self._consecutive_degraded += 1
        else:
            self._consecutive_degraded = 0

        if self._consecutive_degraded >= self.profile.max_consecutive_degraded:
            stats = self._compute_stats()
            if sample.lag_ms > self.profile.saturation_threshold_ms and self._on_saturation:
                self._on_saturation(stats)
            elif sample.lag_ms > self.profile.critical_threshold_ms and self._on_critical:
                self._on_critical(stats)
            elif self._on_warning:
                self._on_warning(stats)

    def get_stats(self) -> LagStats:
        """Return aggregated statistics from collected samples."""
        with self._lock:
            return self._compute_stats()

    def _compute_stats(self) -> LagStats:
        if not self._samples:
            return LagStats()

        lags = sorted(s.lag_ms for s in self._samples)
        n = len(lags)

        def percentile(pct):
            idx = int(n * pct / 100.0)
            return lags[min(idx, n - 1)]

        stats = LagStats(
            count=n,
            min_ms=lags[0],
            max_ms=lags[-1],
            avg_ms=sum(lags) / n,
            p50_ms=percentile(50),
            p95_ms=percentile(95),
            p99_ms=percentile(99),
            degraded_count=sum(1 for v in lags if v > self.profile.alert_threshold_ms),
            critical_count=sum(1 for v in lags if v > self.profile.critical_threshold_ms),
            saturation_count=sum(1 for v in lags if v > self.profile.saturation_threshold_ms),
        )
        return stats

    @property
    def sample_count(self) -> int:
        with self._lock:
            return len(self._samples)

    @property
    def is_degraded(self) -> bool:
        with self._lock:
            return self._consecutive_degraded >= self.profile.max_consecutive_degraded

    def reset(self) -> None:
        """Clear all samples and reset degradation counter."""
        with self._lock:
            self._samples.clear()
            self._consecutive_degraded = 0


def create_alert_logger(logger_name: str = "event_loop.alerts"):
    """Factory for creating a pre-configured alert logger."""
    alert_logger = logging.getLogger(logger_name)
    return alert_logger


def default_warning_callback(stats: LagStats) -> None:
    logger.warning(
        "Event-loop lag WARNING: p95=%.1fms, max=%.1fms, degraded=%d/%d samples",
        stats.p95_ms, stats.max_ms, stats.degraded_count, stats.count,
    )


def default_critical_callback(stats: LagStats) -> None:
    logger.error(
        "Event-loop lag CRITICAL: p95=%.1fms, p99=%.1fms, max=%.1fms",
        stats.p95_ms, stats.p99_ms, stats.max_ms,
    )


def default_saturation_callback(stats: LagStats) -> None:
    logger.critical(
        "Event-loop SATURATION ALARM: avg=%.1fms, p99=%.1fms, saturation_count=%d",
        stats.avg_ms, stats.p99_ms, stats.saturation_count,
    )
