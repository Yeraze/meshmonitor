"""RNS.Reticulum lifecycle: attach/tcp_peer startup, announce enrichment,
interface enumeration, path-table reads.

Applies the four empirical corrections from WP0 (RETICULUM_WP0_SPIKE_EVIDENCE.md §6):

1. A missing (not just permission-denied) configdir is NOT exception-distinguishable
   from "no shared instance" by RNS itself -- it silently bootstraps a fresh default
   config and then fails identically. We pre-check `os.path.isdir()` explicitly so
   CONFIGDIR_UNREADABLE and NO_SHARED_INSTANCE stay distinct for the user.
2. `get_interface_stats()["interfaces"]` includes RNS's own shared-instance plumbing
   (`LocalServerInterface`, one `LocalClientInterface` per attached client). Both are
   filtered out before anything reaches the wire.
3. (Applies to tests, not this module -- see tests/integration/test_dual_rnsd.py.)
4. rssi/snr/q are routinely None over any non-RF hop (loopback/TCP/shared-instance).
   Every signal field is nullable end to end; never assume a value.
"""

from __future__ import annotations

import base64
import logging
import os
import queue
import threading
from typing import Any, Iterable, Optional

import RNS

from . import protocol

logger = logging.getLogger("meshmonitor_rns_bridge.rns_manager")

# WP0 §6.2: RNS's own shared-instance plumbing interfaces, never real user interfaces.
EXCLUDED_INTERFACE_TYPES = frozenset({"LocalServerInterface", "LocalClientInterface"})

# Well-known aspect paths we can positively identify without guessing. Announces for
# any other app/aspect combination still come through (the wildcard handler receives
# everything), just with appName/aspects left None -- RNS's destination hash is a
# one-way hash of (identity, app_name, *aspects), so it cannot be reversed for unknown
# apps; it can only be *matched* against a short allowlist of names we already know.
KNOWN_ASPECT_FILTERS: dict = {
    "lxmf.delivery": ("lxmf", ("delivery",)),
    "lxmf.propagation": ("lxmf", ("propagation",)),
    "nomadnetwork.node": ("nomadnetwork", ("node",)),
}

# RNS.Interfaces.Interface.Interface.MODE_* -- see build spec migration 141 `mode`
# column comment ("full/access-point/etc"). Kept as a local literal table (not an
# import-time introspection of the Interface class) so this stays stable even if RNS
# reorders/renames the constants across versions; unknown values still round-trip as
# a numeric string rather than being dropped.
INTERFACE_MODE_NAMES = {
    1: "full",
    2: "point_to_point",
    3: "access_point",
    4: "roaming",
    5: "boundary",
    6: "gateway",
    7: "internal",
}


class RNSStartupError(Exception):
    """Raised by RNSManager.start() with one of protocol.STARTUP_FAILURE_CODES."""

    def __init__(self, code: str, message: str):
        assert code in protocol.STARTUP_FAILURE_CODES, f"unknown startup failure code {code!r}"
        super().__init__(message)
        self.code = code
        self.message = message


def _hexlify(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return RNS.hexrep(bytes(value), delimit=False)
    return str(value)


def _is_rpc_auth_error(exc: Exception) -> bool:
    """WP0 §5(c): the rpc_key mismatch surfaces as multiprocessing's
    AuthenticationError, imported from a version-sensitive stdlib path, so we match
    by class name + message substring rather than importing the exception type."""
    if type(exc).__name__ == "AuthenticationError":
        return True
    return "digest sent was rejected" in str(exc)


def _decode_display_name(
    app_name: Optional[str], aspects: Optional[tuple], app_data: Optional[bytes]
) -> Optional[str]:
    """Defensively decode a display name from announce app_data (build spec §4.4 point 4).

    Always falls back to None on any failure -- callers must still carry appDataB64 so
    Node can re-parse later without a bridge change once LXMF proper lands in Phase 2.
    """
    if not app_data:
        return None
    if app_name == "lxmf" and aspects and "delivery" in aspects:
        try:
            import RNS.vendor.umsgpack as umsgpack

            unpacked = umsgpack.unpackb(app_data)
            if isinstance(unpacked, (list, tuple)) and unpacked:
                candidate = unpacked[0]
                if isinstance(candidate, (bytes, bytearray)):
                    return bytes(candidate).decode("utf-8", "replace")
                if isinstance(candidate, str):
                    return candidate
        except Exception:
            pass
    try:
        return app_data.decode("utf-8", "replace")
    except Exception:
        return None


def _normalize_interface(raw: dict) -> dict:
    mode = raw.get("mode")
    if isinstance(mode, int):
        mode_name = INTERFACE_MODE_NAMES.get(mode, str(mode))
    elif mode is None:
        mode_name = None
    else:
        mode_name = str(mode)
    online = bool(raw.get("status"))
    return {
        "name": raw.get("short_name") or raw.get("name"),
        "type": raw.get("type"),
        "hash": _hexlify(raw.get("hash")),
        "mode": mode_name,
        "status": "up" if online else "down",
        "online": online,
        "bitrate": raw.get("bitrate"),
        "txBytes": int(raw.get("txb") or 0),
        "rxBytes": int(raw.get("rxb") or 0),
    }


def _normalize_path(raw: dict) -> dict:
    return {
        "destinationHash": _hexlify(raw.get("hash")),
        "via": _hexlify(raw.get("via")),
        "hops": raw.get("hops"),
        "expires": raw.get("expires"),
        "interface": raw.get("interface"),
    }


class _AnnounceHandler:
    """RNS.Transport announce-handler adapter, wildcard (aspect_filter=None).

    RNS inspects the arity of `received_announce` via `inspect.signature` and calls
    accordingly (Transport.py ~L2091-2117); the 5-parameter form is the only one that
    yields `is_path_response` directly, so we always implement all five params.

    Deliberately a SINGLE wildcard handler rather than one handler per known aspect
    filter: RNS executes every registered handler whose aspect_filter matches (and the
    wildcard always matches), so registering both a wildcard and per-aspect handlers
    would double-deliver matching announces. Classification against
    KNOWN_ASPECT_FILTERS happens inside the manager instead, using the same
    `RNS.Destination.hash_from_name_and_identity` RNS uses internally for matching.
    """

    receive_path_responses = True  # build spec §4.4 point 1: else a quiet node
    aspect_filter = None  # vanishes from the list until its next live announce.

    def __init__(self, manager: "RNSManager"):
        self._manager = manager

    def received_announce(
        self,
        destination_hash,
        announced_identity,
        app_data,
        announce_packet_hash=None,
        is_path_response=False,
    ):
        try:
            self._manager._handle_announce(
                destination_hash,
                announced_identity,
                app_data,
                announce_packet_hash,
                is_path_response,
            )
        except Exception:
            logger.exception("error handling announce")


class RNSManager:
    """Owns the process's single RNS.Reticulum instance and fans out normalized
    events (announce / interface_stats / path_table) to subscriber queues.

    RNS.Reticulum is a process-wide singleton (WP0 §6.4): only one `start()` may
    succeed per process. There is no in-process "detach and reattach" -- if the
    underlying rnsd/shared instance disappears, recovery is a fresh OS process
    (see pollers.py's health-driven shutdown and bridge/README.md).
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self.reticulum: Optional[RNS.Reticulum] = None
        self._subscribers: list = []
        self._sub_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._started = False
        self._path_table_cache: list = []
        self._path_table_lock = threading.Lock()
        # Effective RNS-level settings for the current (or most recent) start(),
        # which may have been overridden by a Node `configure` message rather than
        # coming from process env (build spec §4.4: configure carries mode/configDir/
        # peers). Defaults to the env-derived BridgeConfig until start() is called.
        self._effective_mode = cfg.mode
        self._effective_configdir = cfg.rns_config_dir
        self._effective_peers = cfg.tcp_peers
        # RNS.Reticulum() registers SIGINT/SIGTERM handlers in its constructor, which
        # Python only permits from the main thread of the main interpreter -- calling
        # it from a WS connection-handler thread raises "signal only works in main
        # thread of the main interpreter" (found running this against a real rnsd;
        # not covered by the WP0 spike, which ran single-threaded). request_start() +
        # run_dispatcher() below is the thread-safe workaround: any thread can call
        # request_start(), but the actual RNS.Reticulum() construction always happens
        # on whichever thread calls run_dispatcher() -- which must be the main thread.
        self._start_requests: "queue.Queue" = queue.Queue()

    # -- pub/sub --------------------------------------------------------

    def subscribe(self) -> "queue.Queue":
        q: "queue.Queue" = queue.Queue()
        with self._sub_lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue") -> None:
        with self._sub_lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def broadcast(self, event: dict) -> None:
        with self._sub_lock:
            subs = list(self._subscribers)
        for q in subs:
            q.put(event)

    # -- lifecycle --------------------------------------------------------

    @property
    def started(self) -> bool:
        return self._started

    def start(
        self,
        mode: Optional[str] = None,
        rns_config_dir: Optional[str] = None,
        tcp_peers: Optional[Iterable] = None,
    ) -> None:
        """Idempotent: a second call while already started is a no-op. Raises
        RNSStartupError on failure; `.code` is one of protocol.STARTUP_FAILURE_CODES.

        `mode`/`rns_config_dir`/`tcp_peers` override the env-derived BridgeConfig
        defaults when provided -- this is how a Node `configure` message (build spec
        §4.4) takes effect; env vars (config.py) are only the fallback for standalone
        bridge testing/ops.

        CALLER'S RESPONSIBILITY: this must run on the process's main thread (see the
        constructor docstring/comment). Direct callers (tests, single-threaded
        scripts) may call this directly. ws_server.py runs on a per-connection thread
        and MUST use request_start() instead.
        """
        with self._lifecycle_lock:
            if self._started:
                return
            self._effective_mode = mode or self.cfg.mode
            self._effective_configdir = (
                rns_config_dir if rns_config_dir is not None else self.cfg.rns_config_dir
            )
            self._effective_peers = tuple(tcp_peers) if tcp_peers is not None else self.cfg.tcp_peers

            if self._effective_mode == "attach":
                self._start_attach(self._effective_configdir)
            else:
                self._start_tcp_peer(self._effective_configdir, self._effective_peers)
            RNS.Transport.register_announce_handler(_AnnounceHandler(self))
            self._started = True

    def request_start(
        self,
        mode: Optional[str] = None,
        rns_config_dir: Optional[str] = None,
        tcp_peers: Optional[Iterable] = None,
    ) -> None:
        """Thread-safe entry point for callers that are NOT the main thread (e.g. a WS
        connection-handler thread, which is what actually calls this in practice).
        Enqueues the request for run_dispatcher() -- which must be running on the main
        thread -- and blocks until it completes. Raises RNSStartupError on failure,
        same contract as start()."""
        if self._started:
            return
        response_q: "queue.Queue" = queue.Queue(maxsize=1)
        self._start_requests.put((mode, rns_config_dir, tcp_peers, response_q))
        result = response_q.get()
        if isinstance(result, Exception):
            raise result

    def run_dispatcher(self, stop_event: threading.Event) -> None:
        """MUST run on the process's main thread. Services request_start() calls from
        other threads until stop_event is set, by calling the real start() (and
        therefore RNS.Reticulum()) on this thread. Intended to be __main__.py's
        main-thread blocking call, with ws_server.serve() moved to a background
        thread."""
        while not stop_event.is_set():
            try:
                mode, rns_config_dir, tcp_peers, response_q = self._start_requests.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                self.start(mode, rns_config_dir, tcp_peers)
                response_q.put(None)
            except RNSStartupError as e:
                response_q.put(e)
            except Exception as e:  # noqa: BLE001 - must never crash the dispatcher
                logger.exception("unexpected error starting RNS instance")
                response_q.put(RNSStartupError(protocol.RNS_INIT_FAILED, str(e)))

    def stop(self) -> None:
        """Clears bridge-side bookkeeping. Does NOT tear down RNS.Reticulum -- there
        is no supported way to do that short of process exit (see class docstring)."""
        with self._lifecycle_lock:
            self._started = False

    def _start_attach(self, configdir: Optional[str]) -> None:
        # WP0 correction #1: pre-check explicitly. A missing configdir with a
        # writable parent silently bootstraps a fresh default config inside RNS and
        # then fails with the *same* SystemError as "no rnsd running" -- catching
        # only the constructor's exception cannot tell the two apart.
        if configdir is not None:
            if not os.path.isdir(configdir):
                raise RNSStartupError(
                    protocol.CONFIGDIR_UNREADABLE,
                    f"RNS config dir {configdir!r} does not exist or is not a directory",
                )
            if not os.access(configdir, os.R_OK | os.X_OK):
                raise RNSStartupError(
                    protocol.CONFIGDIR_UNREADABLE,
                    f"RNS config dir {configdir!r} is not readable",
                )

        try:
            reticulum = RNS.Reticulum(configdir=configdir, require_shared_instance=True)
        except PermissionError as e:
            # WP0 §5(b2): configdir exists but is unreadable (wrong owner) raises a
            # plain PermissionError while RNS tries to stat its storage subdirectory,
            # before it even parses the config file.
            raise RNSStartupError(protocol.CONFIGDIR_UNREADABLE, str(e)) from e
        except SystemError as e:
            # WP0 §5(a): rnsd absent -- RNS tries to bind the shared-instance listener
            # itself, succeeds (nothing else is listening), realizes it would BECOME
            # the shared instance, and since require_shared_instance=True demanded an
            # *existing* one, it raises SystemError.
            raise RNSStartupError(protocol.NO_SHARED_INSTANCE, str(e)) from e
        except Exception as e:
            raise RNSStartupError(protocol.RNS_INIT_FAILED, str(e)) from e

        # WP0 §5(c): an rpc_key mismatch does NOT surface from the constructor -- the
        # initial attach (packet-forwarding LocalClientInterface, governed only by
        # ifac_netname/ifac_netkey) succeeds regardless. It only surfaces on the
        # *first* out-of-band RPC call, which opens a separate multiprocessing
        # AuthenticationError-guarded channel. Force that call now so RPC_AUTH_FAILED
        # is raised from start() rather than silently from the first stats poll.
        try:
            reticulum.get_interface_stats()
        except Exception as e:
            if _is_rpc_auth_error(e):
                raise RNSStartupError(protocol.RPC_AUTH_FAILED, str(e)) from e
            raise RNSStartupError(protocol.RNS_INIT_FAILED, str(e)) from e

        self.reticulum = reticulum

    def _start_tcp_peer(self, configdir: Optional[str], tcp_peers: Iterable) -> None:
        try:
            reticulum = RNS.Reticulum(configdir=configdir)
        except Exception as e:
            raise RNSStartupError(protocol.RNS_INIT_FAILED, str(e)) from e

        from RNS.vendor.configobj import ConfigObj
        import RNS.Interfaces.TCPInterface as TCPInterface

        connected_any = False
        errors: list = []
        for peer in tcp_peers:
            ifconf = ConfigObj(
                {
                    "name": f"tcp_peer_{peer.host}_{peer.port}",
                    "target_host": peer.host,
                    "target_port": str(peer.port),
                }
            )
            try:
                interface = TCPInterface.TCPClientInterface(RNS.Transport, ifconf)
            except Exception as e:
                errors.append(f"{peer.host}:{peer.port}: {e}")
                continue

            # TCPClientInterface.SYNCHRONOUS_START (True in RNS 1.4.2) makes the
            # constructor above block for the initial connect attempt itself, so
            # `.online` already reflects the outcome by the time we get here --
            # `connect()` catches its own exceptions and returns False rather than
            # raising, logging and leaving a background reconnect thread to retry
            # forever, so we must check `.online` rather than rely on a raise.
            reticulum._add_interface(interface)
            if getattr(interface, "online", False):
                connected_any = True
            else:
                errors.append(f"{peer.host}:{peer.port}: initial connection failed")

        if not connected_any:
            detail = "; ".join(errors) if errors else "no peers configured"
            raise RNSStartupError(protocol.TCP_PEER_UNREACHABLE, detail)

        self.reticulum = reticulum

    # -- announce enrichment --------------------------------------------------

    def _classify(self, destination_hash, announced_identity):
        """Match destination_hash against KNOWN_ASPECT_FILTERS using the same
        mechanism RNS uses internally (Transport.py), without registering duplicate
        per-aspect handlers (see _AnnounceHandler docstring)."""
        if announced_identity is None:
            return None, None
        for full_name, (app_name, aspects) in KNOWN_ASPECT_FILTERS.items():
            try:
                expected = RNS.Destination.hash_from_name_and_identity(full_name, announced_identity)
            except Exception:
                continue
            if expected == destination_hash:
                return app_name, aspects
        return None, None

    def _cached_path_entry(self, destination_hash) -> Optional[dict]:
        with self._path_table_lock:
            table = self._path_table_cache
        for entry in table:
            if entry.get("hash") == destination_hash:
                return entry
        return None

    @staticmethod
    def _safe_signal(fn, packet_hash):
        try:
            return fn(packet_hash)
        except Exception:
            # WP0 §6.3: rssi/snr/q are routinely None over any non-RF hop -- and any
            # RPC hiccup here must never take the announce event down with it.
            return None

    def _handle_announce(
        self,
        destination_hash,
        announced_identity,
        app_data,
        announce_packet_hash,
        is_path_response,
    ) -> None:
        app_name, aspects = self._classify(destination_hash, announced_identity)

        # build spec §4.4 point 3: prefer the RPC/cached path-table hop count over
        # local RNS.Transport.hops_to() -- a shared-instance client's local hop count
        # can be off by one. Falls back to hops_to() before the first path-table poll
        # has populated the cache.
        path_entry = self._cached_path_entry(destination_hash)
        if path_entry is not None:
            hops = path_entry.get("hops")
            next_hop_interface = path_entry.get("interface")
        else:
            try:
                hops = RNS.Transport.hops_to(destination_hash)
            except Exception:
                hops = None
            next_hop_interface = None

        rssi = snr = q = None
        if announce_packet_hash is not None and self.reticulum is not None:
            rssi = self._safe_signal(self.reticulum.get_packet_rssi, announce_packet_hash)
            snr = self._safe_signal(self.reticulum.get_packet_snr, announce_packet_hash)
            q = self._safe_signal(self.reticulum.get_packet_q, announce_packet_hash)

        identity_hash = _hexlify(announced_identity.hash) if announced_identity is not None else None
        app_data_bytes = app_data if isinstance(app_data, (bytes, bytearray)) else None
        app_data_b64 = base64.b64encode(app_data_bytes).decode("ascii") if app_data_bytes else None
        display_name = _decode_display_name(app_name, aspects, app_data_bytes)

        event = protocol.announce_message(
            destination_hash=_hexlify(destination_hash),
            identity_hash=identity_hash,
            app_name=app_name,
            aspects=list(aspects) if aspects else None,
            display_name=display_name,
            app_data_b64=app_data_b64,
            hops=hops,
            next_hop_interface=next_hop_interface,
            rssi=rssi,
            snr=snr,
            q=q,
            is_path_response=bool(is_path_response),
        )
        self.broadcast(event)

    # -- polled reads (called from pollers.py daemon threads) --------------------

    def get_interface_stats(self) -> list:
        """Synchronous fetch, normalized + filtered. Used both by the poller and by
        the attach-mode auth probe in _start_attach()."""
        if self.reticulum is None:
            raise RNSStartupError(protocol.RNS_INIT_FAILED, "RNS instance not started")
        try:
            raw = self.reticulum.get_interface_stats()
        except Exception as e:
            if _is_rpc_auth_error(e):
                raise RNSStartupError(protocol.RPC_AUTH_FAILED, str(e)) from e
            raise
        interfaces = raw.get("interfaces", []) if isinstance(raw, dict) else []
        # WP0 correction #2: filter RNS's own shared-instance plumbing before it ever
        # reaches the wire -- otherwise every attach session shows phantom interfaces.
        return [
            _normalize_interface(i)
            for i in interfaces
            if i.get("type") not in EXCLUDED_INTERFACE_TYPES
        ]

    def refresh_interface_stats(self) -> list:
        """Poller entry point: fetch, broadcast, return (for status()/tests)."""
        interfaces = self.get_interface_stats()
        self.broadcast(protocol.interface_stats_message(interfaces))
        return interfaces

    def refresh_path_table(self) -> list:
        """Poller entry point: fetch, cache (for announce hop enrichment), broadcast."""
        if self.reticulum is None:
            return []
        try:
            raw = self.reticulum.get_path_table()
        except Exception:
            logger.exception("path table read failed")
            return []
        with self._path_table_lock:
            self._path_table_cache = raw
        normalized = [_normalize_path(e) for e in raw]
        self.broadcast(protocol.path_table_message(normalized))
        return normalized

    # -- status --------------------------------------------------------

    def status(self) -> dict:
        connected = self.reticulum is not None
        interface_count = None
        if connected:
            try:
                interface_count = len(self.get_interface_stats())
            except Exception:
                interface_count = None
        return {
            "mode": self._effective_mode,
            "connected": connected,
            "rnsVersion": getattr(RNS, "__version__", None),
            "interfaceCount": interface_count,
        }
