"""Entrypoint: parse env, start RNS, start pollers, serve WebSocket, block.

Threading model (build spec §4.2, refined from the spec's original sketch by a
real-RNS finding not covered by the WP0 spike -- see rns_manager.py's constructor
comment): `RNS.Reticulum()` registers SIGINT/SIGTERM handlers in its constructor,
which Python only allows from the main thread of the main interpreter. Since RNS
initialization happens lazily on the first `configure` from Node (received on a WS
connection-handler thread, not the main thread), this file runs `ws_server.serve()`
in a background thread and keeps the MAIN thread blocked in
`RNSManager.run_dispatcher()`, which is what actually calls `RNS.Reticulum()` when a
`configure` request arrives. Poller threads and the WS server's per-connection
threads are all daemon threads; when the main thread exits, they exit with it.

Exit codes:
  0  -- clean shutdown (SIGTERM/SIGINT)
  1  -- health monitor requested shutdown after repeated RNS poll failures (the
         documented recovery path for "rnsd restarted underneath us", since
         RNS.Reticulum has no supported in-process reattach -- see rns_manager.py).
         The process supervisor (Docker `restart: unless-stopped`) is expected to
         start a fresh process, which attaches cleanly.
  2  -- configuration error (e.g. missing BRIDGE_TOKEN) -- not worth restarting
         blindly; surfaced loudly so the operator fixes the environment.
"""

from __future__ import annotations

import logging
import signal
import sys
import threading

from . import __version__ as BRIDGE_VERSION
from . import ws_server
from .config import ConfigError, load_config
from .pollers import HealthMonitor, start_pollers
from .rns_manager import RNSManager


def _configure_logging(level_name: str) -> None:
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def main(argv=None) -> int:
    try:
        cfg = load_config()
    except ConfigError as e:
        # Logging isn't configured yet -- this is a startup misconfiguration, print
        # directly so it's visible even if BRIDGE_LOG_LEVEL itself is unparsable.
        print(f"meshmonitor-rns-bridge: configuration error: {e}", file=sys.stderr)
        return 2

    _configure_logging(cfg.log_level)
    logger = logging.getLogger("meshmonitor_rns_bridge")
    logger.info(
        "starting meshmonitor-rns-bridge %s (mode=%s bind=%s:%d)",
        BRIDGE_VERSION,
        cfg.mode,
        cfg.host,
        cfg.port,
    )

    manager = RNSManager(cfg)
    health = HealthMonitor()
    stop_event = threading.Event()

    def _signal_handler(signum, _frame):
        logger.info("received signal %d, shutting down", signum)
        stop_event.set()

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    # Pollers are started immediately but their fetch calls no-op (raise
    # RNSStartupError -> logged, health-tracked) until manager.start() has run from
    # the first Node `configure` message -- keeps this file's control flow linear
    # without a chicken-and-egg wait-for-configure step here.
    start_pollers(manager, cfg, health, stop_event)

    shutdown_watcher = threading.Thread(
        target=lambda: (health.shutdown_requested.wait(), stop_event.set()),
        daemon=True,
        name="health-shutdown-watcher",
    )
    shutdown_watcher.start()

    ws_thread = threading.Thread(
        target=ws_server.serve,
        args=(cfg, manager, BRIDGE_VERSION, stop_event),
        daemon=True,
        name="ws-server",
    )
    ws_thread.start()

    # Main thread: services RNSManager.request_start() calls (from WS
    # connection-handler threads) by actually constructing RNS.Reticulum() here, on
    # the main thread, as required. Blocks until stop_event is set.
    manager.run_dispatcher(stop_event)
    ws_thread.join(timeout=5)

    if health.shutdown_requested.is_set():
        logger.error("exiting after repeated RNS failures; expecting supervisor restart")
        return 1

    logger.info("clean shutdown")
    return 0


if __name__ == "__main__":
    sys.exit(main())
