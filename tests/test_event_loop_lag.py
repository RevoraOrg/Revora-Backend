"""Tests for event loop lag monitor."""
import time
import pytest
from monitoring.event_loop_lag import (
    EventLoopLagMonitor,
    SamplingProfile,
    LagStats,
    LagSample,
    default_warning_callback,
    default_critical_callback,
    default_saturation_callback,
)


class TestSamplingProfile:
    def test_default_values(self):
        p = SamplingProfile()
        assert p.window_size == 100
        assert p.sample_interval_s == 1.0
        assert p.alert_threshold_ms == 100.0
        assert p.critical_threshold_ms == 500.0
        assert p.saturation_threshold_ms == 1000.0
        assert p.max_consecutive_degraded == 5

    def test_custom_values(self):
        p = SamplingProfile(
            window_size=50,
            alert_threshold_ms=50.0,
            max_consecutive_degraded=3,
        )
        assert p.window_size == 50
        assert p.alert_threshold_ms == 50.0
        assert p.max_consecutive_degraded == 3


class TestEventLoopLagMonitor:
    def test_initial_state(self):
        m = EventLoopLagMonitor()
        assert m.sample_count == 0
        assert not m.is_degraded
        stats = m.get_stats()
        assert stats.count == 0

    def test_start_and_record(self):
        m = EventLoopLagMonitor(profile=SamplingProfile(sample_interval_s=0.1))
        m.start()
        # Record a few on-time samples
        for _ in range(5):
            sample = m.record()
            assert sample is not None
            assert sample.lag_ms >= 0
        assert m.sample_count == 5

    def test_record_returns_none_when_stopped(self):
        m = EventLoopLagMonitor()
        m.start()
        m.stop()
        assert m.record() is None

    def test_lag_detection(self):
        m = EventLoopLagMonitor(profile=SamplingProfile(sample_interval_s=0.05))
        m.start()
        # First sample should be near-zero lag
        s1 = m.record()
        assert s1.lag_ms < 50  # First sample uses now as baseline
        
        # Simulate lag by waiting before next record
        time.sleep(0.3)
        s2 = m.record()
        assert s2.lag_ms > 50  # Significant lag detected

    def test_stats_aggregation(self):
        m = EventLoopLagMonitor(profile=SamplingProfile(sample_interval_s=0.05))
        m.start()
        for _ in range(10):
            m.record()
        time.sleep(0.1)
        m.record()  # One laggy sample
        
        stats = m.get_stats()
        assert stats.count > 0
        assert stats.min_ms >= 0
        assert stats.max_ms >= stats.min_ms
        assert stats.avg_ms >= stats.min_ms
        assert stats.p50_ms is not None
        assert stats.p95_ms is not None
        assert stats.p99_ms is not None

    def test_degraded_detection(self):
        alerts = []
        profile = SamplingProfile(
            sample_interval_s=0.02,
            alert_threshold_ms=30.0,
            max_consecutive_degraded=2,
        )
        m = EventLoopLagMonitor(
            profile=profile,
            on_warning=lambda s: alerts.append(("warning", s)),
        )
        m.start()
        
        # Normal samples
        for _ in range(3):
            m.record()
        assert not m.is_degraded
        
        # Laggy samples
        time.sleep(0.1)
        m.record()
        time.sleep(0.1)
        m.record()
        
        assert m.is_degraded
        assert len(alerts) >= 1

    def test_critical_and_saturation_callbacks(self):
        alerts = []
        profile = SamplingProfile(
            sample_interval_s=0.01,
            alert_threshold_ms=10.0,
            critical_threshold_ms=50.0,
            saturation_threshold_ms=100.0,
            max_consecutive_degraded=2,
        )
        m = EventLoopLagMonitor(
            profile=profile,
            on_warning=lambda s: alerts.append(("warning", s)),
            on_critical=lambda s: alerts.append(("critical", s)),
            on_saturation=lambda s: alerts.append(("saturation", s)),
        )
        m.start()
        
        # Normal sample
        m.record()
        
        # Severe lag
        time.sleep(0.15)
        m.record()
        time.sleep(0.15)
        m.record()
        
        assert m.is_degraded
        assert len(alerts) >= 1

    def test_reset(self):
        m = EventLoopLagMonitor(profile=SamplingProfile(sample_interval_s=0.05))
        m.start()
        for _ in range(5):
            m.record()
        assert m.sample_count == 5
        
        m.reset()
        assert m.sample_count == 0
        assert not m.is_degraded

    def test_lag_stats_fields(self):
        stats = LagStats(
            count=10, min_ms=1.0, max_ms=100.0, avg_ms=15.0,
            p50_ms=12.0, p95_ms=80.0, p99_ms=95.0,
            degraded_count=3, critical_count=1, saturation_count=0,
        )
        assert stats.count == 10
        assert stats.min_ms == 1.0
        assert stats.max_ms == 100.0
        assert stats.saturation_count == 0

    def test_lag_sample_properties(self):
        sample = LagSample(
            timestamp=100.0, intended_at=99.9, actual_at=100.0, lag_ms=100.0
        )
        assert sample.lag_seconds == 0.1

    def test_monitor_context_manager(self):
        m = EventLoopLagMonitor()
        m.start()
        assert m.sample_count == 0
        m.record()
        assert m.sample_count == 1
        m.stop()


class TestDefaultCallbacks:
    def test_warning_callback(self):
        stats = LagStats(count=10, p95_ms=120.0, max_ms=200.0, degraded_count=5)
        # Should not raise
        default_warning_callback(stats)

    def test_critical_callback(self):
        stats = LagStats(count=10, p95_ms=600.0, p99_ms=800.0, max_ms=900.0)
        default_critical_callback(stats)

    def test_saturation_callback(self):
        stats = LagStats(count=10, avg_ms=1100.0, p99_ms=1500.0, saturation_count=3)
        default_saturation_callback(stats)
