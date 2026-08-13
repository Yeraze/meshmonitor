"""Interface-stats and path-table daemon threads (build spec §4.2).

Also owns the health-driven shutdown signal: since RNS.Reticulum is a process-wide
singleton with no supported in-process reattach (WP0 §6.4), the bridge's answer to
"rnsd restarted underneath us" (attach spec §4.4) is a clean process exit, letting the
container/process supervisor bring up a fresh process that attaches from scratch. See
RNSManager's class docstring and bridge/README.md.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from . import protocol
from .rns_manager import RNSManager, RNSStartupError

logger = logging.getLogger("meshmonitor_rns_bridge.pollers")

# Consecutive poll failures before we conclude the RNS instance is unrecoverable
# in-process and request a clean shutdown.
DEFAULT_UNHEALTHY_THRESHOLD = 3


class HealthMonitor:
    """Tracks consecutive poll failures across all pollers and exposes a single
    shutdown-request event once any poller crosses the failure threshold."""

    def __init__(self, threshold: int = DEFAULT_UNHEALTHY_THRESHOLD):
        self.threshold = threshold
        self._consecutive_failures = 0
        self._lock = threading.Lock()
        self.shutdown_requested = threading.Event()

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0

    def record_failure(self) -> bool:
        """Returns True if this failure crossed the threshold."""
        with self._lock:
            self._consecutive_failures += 1
            tripped = self._consecutive_failures >= self.threshold
        if tripped:
            logger.error(
                "%d consecutive poll failures, requesting bridge shutdown for supervisor restart",
                self._consecutive_failures,
            )
            self.shutdown_requested.set()
        return tripped

    @property
    def consecutive_failures(self) -> int:
        with self._lock:
            return self._consecutive_failures


class _PollerThread(threading.Thread):
    def __init__(
        self,
        name: str,
        interval_s: float,
        fn: Callable[[], object],
        stop_event: threading.Event,
        health: HealthMonitor,
        on_error: Callable[[str, str], None],
        track_health: bool = True,
    ):
        super().__init__(name=name, daemon=True)
        self._interval_s = max(interval_s, 0.1)
        self._fn = fn
        self._stop_event = stop_event
        self._health = health
        self._on_error = on_error
        self._track_health = track_health
        self.iterations = 0
        self.last_error: "tuple | None" = None

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._fn()
                self.iterations += 1
                if self._track_health:
                    self._health.record_success()
            except RNSStartupError as e:
                logger.warning("%s failed: %s (%s)", self.name, e.message, e.code)
                self.last_error = (e.code, e.message)
                self._on_error(e.code, e.message)
                if self._track_health:
                    self._health.record_failure()
            except Exception as e:  # noqa: BLE001 - poller must never die silently
                logger.exception("%s failed unexpectedly", self.name)
                self.last_error = (protocol.RNS_INIT_FAILED, str(e))
                self._on_error(protocol.RNS_INIT_FAILED, f"{self.name} failed: {e}")
                if self._track_health:
                    self._health.record_failure()

            self._stop_event.wait(self._interval_s)


def _guard_not_started(manager: RNSManager, fn: Callable[[], object]) -> Callable[[], object]:
    """Wraps a poll function so it's a no-op before the first successful
    `manager.start()` (triggered by a Node `configure` message) instead of raising
    RNSStartupError('RNS instance not started') every tick -- that's an expected,
    possibly long-lived wait, not a failure, and must not count toward
    HealthMonitor's shutdown threshold."""

    def wrapped():
        if not manager.started:
            return None
        return fn()

    return wrapped


def start_pollers(
    manager: RNSManager,
    cfg,
    health: HealthMonitor,
    stop_event: threading.Event,
) -> list:
    """Start the interface-stats + path-table daemon threads.

    Returns the started Thread objects (tests join/inspect them; production code
    doesn't need to -- they're daemon threads and exit with the process).
    """

    def on_error(code: str, message: str) -> None:
        manager.broadcast(protocol.status_message(code=code, message=message, connected=False))

    stats_thread = _PollerThread(
        "interface_stats_poller",
        cfg.stats_interval_s,
        _guard_not_started(manager, manager.refresh_interface_stats),
        stop_event,
        health,
        on_error,
        track_health=True,
    )
    # The path-table poll is informational in Phase 1a (build spec §4.4) and
    # refresh_path_table() already swallows its own errors (returns [] rather than
    # raising), so it doesn't drive the health monitor -- a flaky path table read
    # should not by itself trigger a bridge restart.
    paths_thread = _PollerThread(
        "path_table_poller",
        cfg.paths_interval_s,
        _guard_not_started(manager, manager.refresh_path_table),
        stop_event,
        health,
        on_error,
        track_health=False,
    )
    stats_thread.start()
    paths_thread.start()
    return [stats_thread, paths_thread]
