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
import time
from typing import Any, Iterable, Optional

import LXMF
import RNS

from . import protocol
from .rnode_kiss import RADIO_STATE_OFF, RADIO_STATE_ON
from .sideband_telemetry import decode_field_telemetry

logger = logging.getLogger("meshmonitor_rns_bridge.rns_manager")

# Phase 2 (LXMF messaging): how long send_lxmf() will wait for an
# unknown-identity destination's path to resolve before giving up (build
# spec §3.5). Bounded deliberately short -- per the epic's anti-grind
# guidance, a send to a destination this bridge has never seen an announce
# from should fail fast with a clear error rather than hang the WS
# connection-handler thread. In the WP1 integration test the two identities
# always exchange an announce first (via `announce_self`), so this path is
# not expected to be exercised in the happy-path test.
LXMF_PATH_WAIT_TIMEOUT_S = 5.0
LXMF_PATH_WAIT_POLL_S = 0.2

# Phase 4 (bridge probe + remote status, build spec §2.B/§2.C, #3960 WP2):
# default timeouts when the Node caller doesn't supply an explicit
# `timeoutS` -- DEFAULT_PROBE_TIMEOUT_S matches RNS's own
# RNS.Utilities.rnprobe DEFAULT_TIMEOUT (12s); DEFAULT_REMOTE_STATUS_TIMEOUT_S
# is a bit longer since it covers path resolution + link establishment +
# TWO round-trip requests (/status and /path), not just one packet. Both
# poll loops reuse LXMF_PATH_WAIT_POLL_S above rather than a new constant.
DEFAULT_PROBE_TIMEOUT_S = 12.0
DEFAULT_REMOTE_STATUS_TIMEOUT_S = 15.0
PROBE_SIZE_BYTES = 16  # matches RNS.Utilities.rnprobe's DEFAULT_PROBE_SIZE

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


# --------------------------------------------------------------------------
# Phase 2 (LXMF messaging): numeric-state / method mapping (build spec §3.3
# "map LXMF numeric states in one place"). Verified against the installed
# lxmf==1.1.1 source (LXMF/LXMessage.py):
#   GENERATING=0x00 OUTBOUND=0x01 SENDING=0x02 SENT=0x04 DELIVERED=0x08
#   REJECTED=0xFD CANCELLED=0xFE FAILED=0xFF
# GENERATING/OUTBOUND (pre-transmission bookkeeping states) fold into the
# wire's "sending", same as SENDING itself -- Node has no use for the
# more granular pre-send states. Any value not listed here (future LXMF
# version adds a state) maps to "failed" -- fail-closed rather than silently
# dropping the event or leaving a message stuck in a UI-facing "sending"
# limbo forever.
_LXMF_STATE_TO_WIRE = {
    LXMF.LXMessage.GENERATING: "sending",
    LXMF.LXMessage.OUTBOUND: "sending",
    LXMF.LXMessage.SENDING: "sending",
    LXMF.LXMessage.SENT: "sent",
    LXMF.LXMessage.DELIVERED: "delivered",
    LXMF.LXMessage.REJECTED: "failed",
    LXMF.LXMessage.CANCELLED: "failed",
    LXMF.LXMessage.FAILED: "failed",
}

# LXMessage.method (int, set once the router determines it) -> the wire's
# method string. Matches migration 143's `method` column comment
# (opportunistic|direct|propagated); UNKNOWN (0, not yet determined -- e.g.
# read immediately after handle_outbound() returns, before the router's
# background thread has picked a method) intentionally has no entry, so
# `.get()` falls through to `None` (nullable on the wire, see
# reticulumProtocol.ts's AnnounceMessage nullable-field precedent).
_LXMF_METHOD_TO_WIRE = {
    LXMF.LXMessage.OPPORTUNISTIC: "opportunistic",
    LXMF.LXMessage.DIRECT: "direct",
    LXMF.LXMessage.PROPAGATED: "propagated",
    LXMF.LXMessage.PAPER: "paper",
}

# Wire method string (Node's `send_lxmf` command, optional `method` field) ->
# LXMessage's `desired_method` constructor arg. Absent/unrecognized ->
# None, meaning "let the router decide" (its normal opportunistic-first
# behavior), which is also send_lxmf()'s default when the field is omitted.
_WIRE_METHOD_TO_LXMF = {
    "opportunistic": LXMF.LXMessage.OPPORTUNISTIC,
    "direct": LXMF.LXMessage.DIRECT,
    "propagated": LXMF.LXMessage.PROPAGATED,
    "paper": LXMF.LXMessage.PAPER,
}

# LXMF field ids (LXMF.FIELD_*) worth naming on the wire for Phase 2's
# "replies/reactions/threads from fields" scope (build spec §6). Anything
# else still round-trips (keyed by its numeric id as a string) rather than
# being dropped, so a client-side field this bridge doesn't specifically
# name yet isn't silently lost.
_FIELD_NAMES = {
    LXMF.FIELD_THREAD: "thread",
    LXMF.FIELD_REPLY_TO: "replyTo",
    LXMF.FIELD_REPLY_QUOTE: "replyQuote",
    LXMF.FIELD_REACTION: "reaction",
    LXMF.FIELD_COMMENT: "comment",
    LXMF.FIELD_RENDERER: "renderer",
    LXMF.FIELD_FILE_ATTACHMENTS: "fileAttachments",
    LXMF.FIELD_IMAGE: "image",
    LXMF.FIELD_AUDIO: "audio",
}

# Raw `bytes` values longer than this are almost certainly attachment/binary
# payload content rather than a short id/hash -- R3 forbids ever putting
# those on the wire, so they collapse to a length-only placeholder instead.
# Short byte strings (hashes, ids -- e.g. FIELD_REPLY_TO's full LXMessage
# hash) are still hex-encoded and passed through, consistent with how the
# rest of this module represents hashes (`_hexlify`).
_MAX_INLINE_BYTES = 32


def _lxmf_state_to_wire(state: Any) -> str:
    return _LXMF_STATE_TO_WIRE.get(state, "failed")


def _lxmf_method_to_wire(method: Any) -> Optional[str]:
    return _LXMF_METHOD_TO_WIRE.get(method)


def _jsonify_field_value(value: Any) -> Any:
    """Recursively converts an LXMF field value (as produced by msgpack
    unpacking -- dict/list/bytes/int/str/float/bool/None) into a JSON-safe
    shape, per R3: attachment/binary content never reaches the wire, only
    metadata (here, a length placeholder for anything long enough to be
    payload rather than an id)."""
    if isinstance(value, (bytes, bytearray)):
        if len(value) <= _MAX_INLINE_BYTES:
            return RNS.hexrep(bytes(value), delimit=False)
        return {"bytesLength": len(value)}
    if isinstance(value, dict):
        return {
            (k.decode("utf-8", "replace") if isinstance(k, (bytes, bytearray)) else str(k)): _jsonify_field_value(v)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_jsonify_field_value(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _sanitize_lxmf_fields(fields: Optional[dict]) -> dict:
    """Build spec §3.3 field sanitation: never inline raw bytes -- attachment
    metadata only (R3). `fields` is `LXMessage.get_fields()`'s raw dict,
    keyed by the numeric `LXMF.FIELD_*` ids."""
    if not fields:
        return {}
    out: dict = {}
    for key, value in fields.items():
        name = _FIELD_NAMES.get(key, str(key))
        out[name] = _jsonify_field_value(value)
    return out


def _load_or_create_lxmf_identity(storage_dir: str) -> RNS.Identity:
    """Build spec §3.4 / R5: the LXMF private key lives ONLY on the bridge
    filesystem, never in MeshMonitor's DB. First run creates and persists a
    fresh identity to `<storage_dir>/identity`; every subsequent run loads
    the same one back, so the source's LXMF address is stable across
    restarts as long as this directory is a persisted volume (documented in
    the deployment guide -- a fresh container without that volume regenerates
    the identity, a new address)."""
    os.makedirs(storage_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(storage_dir, 0o700)
    except OSError:
        # Best-effort on filesystems that don't support Unix perms (rare for
        # this deployment's alpine/linux target, but must never crash startup).
        pass

    identity_path = os.path.join(storage_dir, "identity")
    if os.path.isfile(identity_path):
        identity = RNS.Identity.from_file(identity_path)
        if identity is not None:
            return identity
        logger.warning("failed to load LXMF identity from %s; generating a new one", identity_path)

    identity = RNS.Identity()
    identity.to_file(identity_path)
    try:
        os.chmod(identity_path, 0o600)
    except OSError:
        pass
    return identity


class RNSStartupError(Exception):
    """Raised by RNSManager.start() with one of protocol.STARTUP_FAILURE_CODES."""

    def __init__(self, code: str, message: str):
        assert code in protocol.STARTUP_FAILURE_CODES, f"unknown startup failure code {code!r}"
        super().__init__(message)
        self.code = code
        self.message = message


class OwnModeRequiredError(Exception):
    """Raised by get_radio_config()/set_radio_config()/get_device_info() when
    this source isn't running in `own` mode (attach/tcp_peer have no local
    RNodeInterface to read or configure). ws_server.py catches this
    specifically and returns the typed OWN_MODE_REQUIRED error, distinct
    from the generic exception-wrapped RNODE_COMMAND_FAILED it uses for
    every other failure in this command family -- build spec §2.B: "return
    a typed own-mode-required error, never crash"."""


class RemoteManagementDeniedError(Exception):
    """Raised by get_remote_status() (Phase 4, #3960 WP2) when a link to
    the remote's `rnstransport.remote.management` destination established
    successfully (proving the target is alive and reachable) but BOTH its
    /status and /path requests failed to conclude. ws_server.py catches
    this specifically and returns the typed REMOTE_MANAGEMENT_DENIED
    error, distinct from the generic exception-wrapped REMOTE_STATUS_FAILED
    it uses for every other failure in get_remote_status() -- see that
    method's docstring for why RNS's own ALLOW_LIST request-handler gate
    makes this the best available signal for "denied" (RNS never sends an
    explicit denial on the wire)."""


def _build_rnode_ifconf(device: str, params: dict) -> dict:
    """Pure builder (Phase 3, #3960 WP1) for the ConfigObj dict
    `RNS.Interfaces.RNodeInterface.RNodeInterface.__init__` expects.
    Verified against the installed rns==1.4.2 source: every value it reads
    off the config object goes through `int(c["key"])` / `float(c["key"])`
    (or is a bare string for "port"/"name"), so every value here must be a
    string -- ConfigObj itself doesn't coerce types.

    `params` keys are the internal wire-agnostic names shared by
    `config.py`'s `own_radio_params()` and `ws_server.py`'s
    `_parse_own_params()` (frequency, bandwidth, sf, cr, txpower,
    st_alock, lt_alock); any subset may be omitted, matching
    RNodeInterface's own defaults for a missing key (0 for
    frequency/bandwidth/txpower/sf/cr, unset -- None -- for the two
    airtime locks)."""
    conf: dict = {"name": "own_rnode", "port": device}
    if params.get("frequency") is not None:
        conf["frequency"] = str(int(params["frequency"]))
    if params.get("bandwidth") is not None:
        conf["bandwidth"] = str(int(params["bandwidth"]))
    if params.get("txpower") is not None:
        conf["txpower"] = str(int(params["txpower"]))
    if params.get("sf") is not None:
        conf["spreadingfactor"] = str(int(params["sf"]))
    if params.get("cr") is not None:
        conf["codingrate"] = str(int(params["cr"]))
    if params.get("st_alock") is not None:
        conf["airtime_limit_short"] = str(float(params["st_alock"]))
    if params.get("lt_alock") is not None:
        conf["airtime_limit_long"] = str(float(params["lt_alock"]))
    return conf


# Radio-config wire field name -> (RNodeInterface attribute, RNodeInterface
# setter method name). Used by both get_radio_config() (read the attribute)
# and set_radio_config() (write the attribute, then call the setter to push
# it to the device over KISS -- exactly what RNS's own configure_device()
# does at interface startup). radioState is handled separately below since
# its setter (setRadioState) takes an explicit argument rather than reading
# back off an attribute the way the others do.
_RADIO_CONFIG_SETTERS = {
    "frequency": ("frequency", "setFrequency"),
    "bandwidth": ("bandwidth", "setBandwidth"),
    "spreadingFactor": ("sf", "setSpreadingFactor"),
    "codingRate": ("cr", "setCodingRate"),
    "txPower": ("txpower", "setTXPower"),
    "stAlock": ("st_alock", "setSTALock"),
    "ltAlock": ("lt_alock", "setLTALock"),
}


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


class _RNSProbeBackend:
    """Real RNS calls used by probe()/get_remote_status() (Phase 4, build
    spec §2.B/§2.C, #3960 WP2). Isolated behind this class so tests
    substitute a MagicMock/fake stand-in wholesale
    (`RNSManager._probe_backend = ...`) rather than patching a dozen
    individual RNS.* names one at a time -- R1 (build spec §0): CONTRACT/
    UNIT-ONLY, mocked RNS, no live dual-rnsd network in the default suite.

    API surface verified against the vendored rns==1.4.2 package (`import
    RNS` is NOT available in this dev shell -- confirmed instead by
    `pip install rns==1.4.2` into a throwaway venv and reading the
    installed source directly, per build spec §2.C "verify the exact RNS
    remote-management client API against the vendored RNS in the bridge
    image"):

      - RNS.Transport registers TWO built-in per-instance management
        destinations when the TARGET enables them in its own config, both
        constructed from the same `Transport.identity` (the per-process
        transport-layer identity -- distinct from any app-level identity
        like an LXMF delivery identity):
          * app_name="rnstransport", aspects=("probe",) -- only exists when
            the target sets `probe_destination_enabled` (Reticulum config);
            `set_proof_strategy(PROVE_ALL)` means ANY correctly addressed +
            encrypted RNS.Packet gets an automatic proof back, no Link/
            Request needed. This is the actual mechanism
            RNS.Utilities.rnprobe (RNS's own CLI probe tool) uses.
          * app_name="rnstransport", aspects=("remote", "management") --
            only exists when the target sets `enable_remote_management`;
            reachable only via an RNS.Link + Link.request(), with
            "/status" and "/path" handlers gated by
            RNS.Destination.ALLOW_LIST against `remote_management_allowed`
            (an identity-hash allowlist configured ON THE TARGET, unrelated
            to our own RNS_REMOTE_ALLOWED querying-side allowlist in
            config.py).
      - Both operations need the destinationHash the operator configures to
        already BE the target's probe / remote-management destination hash
        specifically (not e.g. its LXMF delivery hash) -- there is no way
        to derive one from the other, since they're different (identity,
        app_name, aspects) tuples even for the same physical node. This
        mirrors how rnprobe itself requires the operator to supply the full
        dotted app name alongside the raw hash on its CLI.
      - `RNS.Identity.recall(destination_hash)` returns "the identity that
        announced this destination hash", regardless of what app_name/
        aspects produced it -- reconstructing
        `RNS.Destination(identity, OUT, SINGLE, "rnstransport", ...)` from
        it reproduces the SAME hash as the target's real probe/remote-
        management destination (Destination.hash() is a pure function of
        identity + app_name + aspects), which is what makes addressing
        either one from just a destinationHash possible at all.
    """

    APP_NAME = "rnstransport"  # RNS.Transport.APP_NAME -- hardcoded here
    # rather than imported off the (internal) Transport class, since it's
    # not part of RNS's documented public API; verified stable in rns==1.4.2.
    PROBE_ASPECTS = ("probe",)
    REMOTE_MGMT_ASPECTS = ("remote", "management")

    def has_path(self, destination_hash: bytes) -> bool:
        return RNS.Transport.has_path(destination_hash)

    def request_path(self, destination_hash: bytes) -> None:
        RNS.Transport.request_path(destination_hash)

    def hops_to(self, destination_hash: bytes) -> Optional[int]:
        try:
            return RNS.Transport.hops_to(destination_hash)
        except Exception:
            return None

    def recall_identity(self, destination_hash: bytes) -> Optional["RNS.Identity"]:
        return RNS.Identity.recall(destination_hash)

    def send_probe(self, identity: "RNS.Identity") -> "RNS.PacketReceipt":
        """Builds the target's `rnstransport.probe` destination from
        `identity` and sends one probe packet, returning the
        RNS.PacketReceipt -- mirrors RNS.Utilities.rnprobe's
        program_setup()."""
        request_destination = RNS.Destination(
            identity, RNS.Destination.OUT, RNS.Destination.SINGLE, self.APP_NAME, *self.PROBE_ASPECTS
        )
        packet = RNS.Packet(request_destination, os.urandom(PROBE_SIZE_BYTES))
        return packet.send()

    def open_management_link(self, identity: "RNS.Identity") -> "RNS.Link":
        """Builds the target's `rnstransport.remote.management` destination
        from `identity` and opens an RNS.Link to it."""
        destination = RNS.Destination(
            identity, RNS.Destination.OUT, RNS.Destination.SINGLE, self.APP_NAME, *self.REMOTE_MGMT_ASPECTS
        )
        return RNS.Link(destination)

    def link_request(self, link: "RNS.Link", path: str, data: Any, timeout_s: float) -> "RNS.RequestReceipt | None":
        """`data` MUST be a list matching what RNS.Transport's own
        remote_status_handler/remote_path_handler (Transport.py, verified
        against the vendored rns==1.4.2 source) expect -- both bail out to
        `None` (server-side, no response at all) for any non-list `data`:
          - "/status": `[True]` (the bool requests the link-count be
            included alongside interface stats; `[False]`/`[]` omits it).
          - "/path": `["table"]` (the "table" command; remote_path_handler
            also supports "rates", not used here)."""
        return link.request(path, data=data, timeout=timeout_s)


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
        # Phase 2 (LXMF messaging): one LXMRouter per process (build spec
        # §3.2), started alongside RNS itself in start(). `delivery_destination`
        # is the RNS.Destination returned by register_delivery_identity() --
        # its `.hash` is this source's PUBLIC LXMF address, returned in
        # ready/status/get_identity.
        self.lxmf_router: Optional["LXMF.LXMRouter"] = None
        self.lxmf_identity: Optional[RNS.Identity] = None
        self.delivery_destination: Optional[RNS.Destination] = None
        # Phase 3 (own mode, #3960 WP1): the RNodeInterface instance
        # constructed by _start_own(), None in attach/tcp_peer mode (or
        # before start() has run). get_radio_config()/set_radio_config()/
        # get_device_info() all read/write through this.
        self._rnode_interface: Optional[Any] = None
        # Effective RNS-level settings for the current (or most recent) start(),
        # which may have been overridden by a Node `configure` message rather than
        # coming from process env (build spec §4.4: configure carries mode/configDir/
        # peers). Defaults to the env-derived BridgeConfig until start() is called.
        self._effective_mode = cfg.mode
        self._effective_configdir = cfg.rns_config_dir
        self._effective_peers = cfg.tcp_peers
        # Phase 3: same override-from-configure pattern as the three fields
        # above, for own mode's device path + initial radio params.
        self._effective_own_device = cfg.own_device
        self._effective_own_params = {
            k: v
            for k, v in {
                "frequency": cfg.own_frequency,
                "bandwidth": cfg.own_bandwidth,
                "sf": cfg.own_sf,
                "cr": cfg.own_cr,
                "txpower": cfg.own_txpower,
                "st_alock": cfg.own_st_alock,
                "lt_alock": cfg.own_lt_alock,
            }.items()
            if v is not None
        }
        # RNS.Reticulum() registers SIGINT/SIGTERM handlers in its constructor, which
        # Python only permits from the main thread of the main interpreter -- calling
        # it from a WS connection-handler thread raises "signal only works in main
        # thread of the main interpreter" (found running this against a real rnsd;
        # not covered by the WP0 spike, which ran single-threaded). request_start() +
        # run_dispatcher() below is the thread-safe workaround: any thread can call
        # request_start(), but the actual RNS.Reticulum() construction always happens
        # on whichever thread calls run_dispatcher() -- which must be the main thread.
        self._start_requests: "queue.Queue" = queue.Queue()
        # Phase 4 (bridge probe + remote status, #3960 WP2): swappable seam
        # for probe()/get_remote_status() -- see `_RNSProbeBackend`'s
        # docstring. Tests replace this attribute wholesale with a fake.
        self._probe_backend = _RNSProbeBackend()

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
        own_device: Optional[str] = None,
        own_params: Optional[dict] = None,
    ) -> None:
        """Idempotent: a second call while already started is a no-op. Raises
        RNSStartupError on failure; `.code` is one of protocol.STARTUP_FAILURE_CODES.

        `mode`/`rns_config_dir`/`tcp_peers`/`own_device`/`own_params` override the
        env-derived BridgeConfig defaults when provided -- this is how a Node
        `configure` message (build spec §4.4, extended for own mode in §2.C) takes
        effect; env vars (config.py) are only the fallback for standalone bridge
        testing/ops.

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
            if own_device is not None:
                self._effective_own_device = own_device
            if own_params is not None:
                self._effective_own_params = dict(own_params)

            if self._effective_mode == "attach":
                self._start_attach(self._effective_configdir)
            elif self._effective_mode == "tcp_peer":
                self._start_tcp_peer(self._effective_configdir, self._effective_peers)
            else:
                self._start_own(
                    self._effective_configdir, self._effective_own_device, self._effective_own_params
                )
            RNS.Transport.register_announce_handler(_AnnounceHandler(self))
            self._start_lxmf()
            self._started = True

    def request_start(
        self,
        mode: Optional[str] = None,
        rns_config_dir: Optional[str] = None,
        tcp_peers: Optional[Iterable] = None,
        own_device: Optional[str] = None,
        own_params: Optional[dict] = None,
    ) -> None:
        """Thread-safe entry point for callers that are NOT the main thread (e.g. a WS
        connection-handler thread, which is what actually calls this in practice).
        Enqueues the request for run_dispatcher() -- which must be running on the main
        thread -- and blocks until it completes. Raises RNSStartupError on failure,
        same contract as start()."""
        if self._started:
            return
        response_q: "queue.Queue" = queue.Queue(maxsize=1)
        self._start_requests.put((mode, rns_config_dir, tcp_peers, own_device, own_params, response_q))
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
                mode, rns_config_dir, tcp_peers, own_device, own_params, response_q = self._start_requests.get(
                    timeout=0.2
                )
            except queue.Empty:
                continue
            try:
                self.start(mode, rns_config_dir, tcp_peers, own_device, own_params)
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

    def _start_own(
        self, configdir: Optional[str], device: Optional[str], radio_params: Optional[dict]
    ) -> None:
        """own mode (Phase 3 WP1, build spec §2.B/§3.3 "own" row, #3960): the
        bridge owns the RNode radio directly via
        RNS.Interfaces.RNodeInterface on `device` (e.g. /dev/ttyUSB0),
        rather than attaching to someone else's rnsd (attach) or a remote
        TCPServerInterface (tcp_peer).

        RNodeInterface.__init__ does NOT raise on a bad/missing serial
        port -- verified against the installed rns==1.4.2 source: it logs,
        spawns a background reconnect thread, and leaves `.online == False`.
        So both failure modes -- device path missing entirely, and device
        path present but the open failed for some other reason (wrong
        permissions, not a serial device, unplugged) -- are caught by an
        explicit precheck / post-construction `.online` check, mirroring
        WP0 correction #1's configdir precheck in _start_attach() above.

        Anti-grind guard (#3960 Phase 3 R1): validated in CI ONLY against a
        mocked RNodeInterface (test_rns_manager.py) -- no physical device,
        no live serial open, ever.
        """
        if not device:
            raise RNSStartupError(protocol.RNODE_DEVICE_UNAVAILABLE, "own mode requires a device path")
        if not os.path.exists(device):
            raise RNSStartupError(
                protocol.RNODE_DEVICE_UNAVAILABLE, f"RNode device {device!r} does not exist"
            )

        try:
            reticulum = RNS.Reticulum(configdir=configdir)
        except Exception as e:
            raise RNSStartupError(protocol.RNS_INIT_FAILED, str(e)) from e

        try:
            import RNS.Interfaces.RNodeInterface as RNodeInterfaceModule
            from RNS.vendor.configobj import ConfigObj
        except Exception as e:
            # Guarded import (build spec §2.B "guard imports so a missing device
            # fails cleanly"): RNodeInterface's own module-level import of
            # `serial` (pyserial) calls RNS.panic() -- effectively os._exit() --
            # rather than raising, if pyserial isn't installed. That can't be
            # caught here, by design of the upstream code; this try/except only
            # covers the (more survivable) case of the submodule import itself
            # failing for some other reason.
            raise RNSStartupError(protocol.RNODE_DEVICE_UNAVAILABLE, str(e)) from e

        ifconf = ConfigObj(_build_rnode_ifconf(device, radio_params or {}))

        try:
            interface = RNodeInterfaceModule.RNodeInterface(RNS.Transport, ifconf)
        except Exception as e:
            raise RNSStartupError(protocol.RNODE_DEVICE_UNAVAILABLE, str(e)) from e

        reticulum._add_interface(interface)
        if not getattr(interface, "online", False):
            raise RNSStartupError(
                protocol.RNODE_DEVICE_UNAVAILABLE, f"RNode device {device!r} did not come online"
            )

        self._rnode_interface = interface
        self.reticulum = reticulum

    # -- LXMF (Phase 2 messaging, build spec §3.2) -----------------------------

    def _start_lxmf(self) -> None:
        """Called once from start(), after self.reticulum is up (both attach
        and tcp_peer modes reach this point identically). Idempotent -- a
        second start() call (already a start() no-op via `_started`) never
        gets here twice, but this guard also protects request_start() retries.

        Failure here is folded into RNS_INIT_FAILED: LXMF is not optional
        infrastructure in Phase 2 (unlike, say, a path-table read failing),
        so a broken LXMF init should fail the whole `configure` the same way
        a broken RNS.Reticulum() construction does.
        """
        if self.lxmf_router is not None:
            return
        try:
            self.lxmf_identity = _load_or_create_lxmf_identity(self.cfg.lxmf_storage_dir)
            self.lxmf_router = LXMF.LXMRouter(identity=self.lxmf_identity, storagepath=self.cfg.lxmf_storage_dir)
            self.delivery_destination = self.lxmf_router.register_delivery_identity(
                self.lxmf_identity, display_name=None
            )
            self.lxmf_router.register_delivery_callback(self._on_lxmf_delivery)
        except Exception as e:
            self.lxmf_router = None
            self.delivery_destination = None
            raise RNSStartupError(protocol.RNS_INIT_FAILED, f"LXMF router failed to start: {e}") from e

    def _require_lxmf(self) -> "LXMF.LXMRouter":
        if self.lxmf_router is None or self.delivery_destination is None:
            raise RNSStartupError(protocol.RNS_INIT_FAILED, "LXMF router not started")
        return self.lxmf_router

    # -- LXMF inbound (build spec §3.3) ----------------------------------------

    def _on_lxmf_delivery(self, message: "LXMF.LXMessage") -> None:
        """LXMRouter's delivery callback -- fires for every inbound LXM
        addressed to this source's delivery destination. Broadcasts a
        `lxmf_message` event; never raises back into LXMRouter (matches the
        _AnnounceHandler pattern -- an exception here must not take down the
        router's calling thread).

        Phase 3 WP2 (#3960, build spec §2.A): `LXMF.FIELD_TELEMETRY` is
        intercepted HERE, off the raw `get_fields()` dict, BEFORE it reaches
        `_sanitize_lxmf_fields()` -- that generic path hex-collapses any
        `bytes` field over `_MAX_INLINE_BYTES` (32) to a length-only
        placeholder (`{"bytesLength": N}`), and a real Sideband
        FIELD_TELEMETRY blob is comfortably over that (the WP0 fixture alone
        is 75 bytes), so relying on the generic path would produce nothing
        useful. A telemetry-only delivery (no title/content) emits ONLY the
        `telemetry` event -- no `lxmf_message` event, so Node never creates a
        chat row for it (R3). A delivery carrying both text and telemetry
        emits BOTH events."""
        try:
            raw_fields = message.get_fields() or {}
            telemetry_raw = raw_fields.get(LXMF.FIELD_TELEMETRY)
            if telemetry_raw is not None:
                self._emit_telemetry_event(message, telemetry_raw)

            title = message.title_as_string() if message.title else None
            content = message.content_as_string() if message.content else None
            telemetry_only = telemetry_raw is not None and not title and not content
            if telemetry_only:
                return

            event = protocol.lxmf_message_event(
                hash=_hexlify(message.hash),
                from_hash=_hexlify(message.source_hash),
                to_hash=_hexlify(message.destination_hash),
                title=title,
                content=content,
                fields=_sanitize_lxmf_fields(raw_fields),
                method=_lxmf_method_to_wire(message.method),
                signature_validated=bool(message.signature_validated),
                ratcheted=message.ratchet_id is not None,
                rssi=message.rssi,
                snr=message.snr,
                q=message.q,
            )
            self.broadcast(event)
        except Exception:
            logger.exception("error handling inbound LXMF delivery")

    def _emit_telemetry_event(self, message: "LXMF.LXMessage", telemetry_raw: Any) -> None:
        """Decode+broadcast one LXM's `FIELD_TELEMETRY` payload as a
        `telemetry` event (build spec §2.A/§2.C). Isolated in its own
        try/except so a decode failure can never suppress the sibling
        `lxmf_message` event for a text+telemetry delivery -- worst case,
        this emits nothing and `_on_lxmf_delivery` carries on."""
        try:
            if not isinstance(telemetry_raw, (bytes, bytearray)):
                logger.warning(
                    "FIELD_TELEMETRY value is not bytes (%s); skipping decode",
                    type(telemetry_raw).__name__,
                )
                return
            decoded = decode_field_telemetry(bytes(telemetry_raw))
            event = protocol.telemetry_event(
                source_hash=_hexlify(message.source_hash),
                destination_hash=_hexlify(message.destination_hash),
                sensors=decoded["sensors"],
                location=decoded["location"],
                ts=decoded["ts"],
            )
            self.broadcast(event)
        except Exception:
            logger.exception("error decoding/broadcasting FIELD_TELEMETRY")

    # -- LXMF outbound (build spec §3.5) ---------------------------------------

    def _on_lxmf_outbound_state(self, message: "LXMF.LXMessage") -> None:
        """Shared delivery-state AND failed-state callback for an outbound
        LXMessage (registered on both `register_delivery_callback` and
        `register_failed_callback` in send_lxmf() below) -- by the time
        either fires, `message.state` already reflects the terminal/
        transitional value, so one handler covers both via
        `_lxmf_state_to_wire`, per build spec's "map LXMF numeric states in
        one place"."""
        try:
            event = protocol.delivery_state_event(
                hash=_hexlify(message.hash),
                state=_lxmf_state_to_wire(message.state),
                method=_lxmf_method_to_wire(message.method),
                attempts=message.delivery_attempts,
            )
            self.broadcast(event)
        except Exception:
            logger.exception("error handling outbound LXMF delivery-state callback")

    def send_lxmf(
        self,
        to_hash_hex: str,
        title: str = "",
        content: str = "",
        fields: Optional[dict] = None,
        method: Optional[str] = None,
        propagation_node_hex: Optional[str] = None,
    ) -> str:
        """Build spec §3.5: `send_lxmf` command handler's implementation.
        Returns the assigned LXM hash (hex) -- ws_server.py replies with it
        as the command's `delivery_state` response (state="sending").

        Raises ValueError for a caller/input problem (unknown destination,
        malformed hash) and RNSStartupError if LXMF isn't started -- both are
        caught by ws_server.py's exception-wrapped command handler and turned
        into an `error` envelope, never left to propagate into the
        connection-handler loop.
        """
        router = self._require_lxmf()

        try:
            destination_hash = bytes.fromhex(to_hash_hex)
        except (TypeError, ValueError) as e:
            raise ValueError(f"invalid destination hash {to_hash_hex!r}: {e}") from e

        identity = RNS.Identity.recall(destination_hash)
        if identity is None:
            RNS.Transport.request_path(destination_hash)
            deadline = time.monotonic() + LXMF_PATH_WAIT_TIMEOUT_S
            while identity is None and time.monotonic() < deadline:
                time.sleep(LXMF_PATH_WAIT_POLL_S)
                identity = RNS.Identity.recall(destination_hash)
        if identity is None:
            raise ValueError(f"no known path/identity for destination {to_hash_hex}")

        destination = RNS.Destination(identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery")

        desired_method = _WIRE_METHOD_TO_LXMF.get(method) if method else None
        if propagation_node_hex and desired_method == LXMF.LXMessage.PROPAGATED:
            router.set_outbound_propagation_node(bytes.fromhex(propagation_node_hex))

        message = LXMF.LXMessage(
            destination,
            self.delivery_destination,
            content or "",
            title or "",
            fields=fields,
            desired_method=desired_method,
        )
        message.register_delivery_callback(self._on_lxmf_outbound_state)
        message.register_failed_callback(self._on_lxmf_outbound_state)

        router.handle_outbound(message)
        # handle_outbound() calls message.pack() synchronously before handing
        # off to its background processing thread, so .hash is already set
        # by the time control returns here (verified against lxmf==1.1.1
        # source -- LXMRouter.handle_outbound()).
        return _hexlify(message.hash)

    # -- LXMF identity / propagation / display name (build spec §3.5) ---------

    def announce_self(self) -> None:
        router = self._require_lxmf()
        router.announce(self.delivery_destination.hash)

    def set_display_name(self, display_name: Optional[str]) -> None:
        self._require_lxmf()
        # display_name is a plain mutable attribute on the delivery
        # Destination (see LXMRouter.get_announce_app_data(), which reads it
        # live on every announce) -- no re-registration needed.
        self.delivery_destination.display_name = display_name or None

    def sync_propagation(self) -> None:
        """Best-effort (build spec §2.4 / R5 doc note): kicks off a
        propagation-node message sync. Store-and-forward convergence itself
        is not hard-gated by WP1's acceptance criteria."""
        router = self._require_lxmf()
        router.request_messages_from_propagation_node(self.lxmf_identity)

    def set_propagation_node(self, destination_hash_hex: Optional[str]) -> None:
        router = self._require_lxmf()
        if not destination_hash_hex:
            raise ValueError("destinationHash is required")
        try:
            destination_hash = bytes.fromhex(destination_hash_hex)
        except (TypeError, ValueError) as e:
            raise ValueError(f"invalid destination hash {destination_hash_hex!r}: {e}") from e
        router.set_outbound_propagation_node(destination_hash)

    def get_identity_info(self) -> dict:
        """PUBLIC info only (R2/R5): destination hash + identity hash +
        display name. The private key itself never leaves this process --
        there is deliberately no accessor here for it; import/export of the
        raw key stays local to import_identity()/_load_or_create_lxmf_identity()."""
        self._require_lxmf()
        return {
            "destinationHash": _hexlify(self.delivery_destination.hash),
            "identityHash": _hexlify(self.lxmf_identity.hash),
            "displayName": self.delivery_destination.display_name,
        }

    def import_identity(self, private_key_b64: Optional[str]) -> None:
        """Bridge-internal-only command (R2): the private key travels over
        this trusted, token-authenticated bridge<->Node WS link, but there is
        deliberately NO Node HTTP route that exposes or accepts it (WP4 must
        not add one -- see protocol.py's `import_identity_message` docstring).

        Persists the imported identity to LXMF_STORAGE_DIR so a subsequent
        restart loads it back via the normal load-or-create path. Does NOT
        hot-swap the already-running LXMRouter's registered delivery
        identity in-process -- consistent with RNS.Reticulum's own
        no-supported-in-process-reattach constraint (see this class's
        docstring), full effect requires a bridge restart, the same
        supervisor-restart recovery path used elsewhere in this module.
        """
        if not private_key_b64:
            raise ValueError("privateKeyB64 is required")
        try:
            raw = base64.b64decode(private_key_b64, validate=True)
        except Exception as e:
            raise ValueError(f"privateKeyB64 is not valid base64: {e}") from e
        identity = RNS.Identity.from_bytes(raw)
        if identity is None:
            raise ValueError("invalid private key: could not reconstruct an RNS.Identity from it")
        identity.to_file(os.path.join(self.cfg.lxmf_storage_dir, "identity"))
        try:
            os.chmod(os.path.join(self.cfg.lxmf_storage_dir, "identity"), 0o600)
        except OSError:
            pass
        self.lxmf_identity = identity

    # -- own mode: radio config / device info (Phase 3 WP1, build spec §2.B/§2.C) --

    def _require_rnode(self) -> Any:
        """Raises OwnModeRequiredError unless this source is running in
        `own` mode with a live RNodeInterface -- shared guard for all three
        radio-config/device-info methods below."""
        if self._effective_mode != "own" or self._rnode_interface is None:
            raise OwnModeRequiredError("this source is not running in own mode (no RNode interface)")
        return self._rnode_interface

    def get_radio_config(self) -> dict:
        """Reads the CURRENTLY CONFIGURED (not necessarily device-confirmed)
        radio params straight off the RNodeInterface's own attributes --
        the same attributes RNS itself sets at construction time and
        mutates via setFrequency()/setBandwidth()/etc. Wire field names
        match build spec §2.C exactly."""
        interface = self._require_rnode()
        state = getattr(interface, "state", None)
        return {
            "frequency": getattr(interface, "frequency", None),
            "bandwidth": getattr(interface, "bandwidth", None),
            "spreadingFactor": getattr(interface, "sf", None),
            "codingRate": getattr(interface, "cr", None),
            "txPower": getattr(interface, "txpower", None),
            "stAlock": getattr(interface, "st_alock", None),
            "ltAlock": getattr(interface, "lt_alock", None),
            "radioState": bool(state) if state is not None else None,
        }

    def set_radio_config(self, params: dict) -> dict:
        """Applies a partial radio-config write (build spec §2.C: "partial
        allowed") -- only the wire keys present in `params` are touched,
        others are left as-is. Each field is applied by setting the
        matching RNodeInterface attribute and then calling ITS OWN setter
        method (e.g. `interface.frequency = value; interface.setFrequency()`)
        -- reuses RNS's real KISS-frame-writing code (the same path its own
        configure_device() uses at startup) rather than reimplementing wire
        writes here. Returns the post-write config via get_radio_config()."""
        interface = self._require_rnode()
        for wire_key, (attr, setter_name) in _RADIO_CONFIG_SETTERS.items():
            if wire_key in params and params[wire_key] is not None:
                setattr(interface, attr, params[wire_key])
                getattr(interface, setter_name)()
        if "radioState" in params and params["radioState"] is not None:
            interface.setRadioState(RADIO_STATE_ON if params["radioState"] else RADIO_STATE_OFF)
        return self.get_radio_config()

    def get_device_info(self) -> dict:
        """Reads DEVICE-REPORTED info (firmware version, MCU/platform,
        chip temperature, CSMA + PHY params) off the RNodeInterface's `r_*`
        attributes -- populated asynchronously by RNS's own readLoop() as
        the device sends its periodic STAT frames, so any of these may
        still be None shortly after `own` mode starts (before the first
        report has arrived). Shape matches build spec §2.C: firmwareVersion,
        mcu, platform, chipTemp, csma{}, phy{}."""
        interface = self._require_rnode()
        maj = getattr(interface, "maj_version", None)
        min_ = getattr(interface, "min_version", None)
        firmware_version = f"{maj}.{min_}" if maj is not None and min_ is not None else None
        return {
            "firmwareVersion": firmware_version,
            "mcu": getattr(interface, "mcu", None),
            "platform": getattr(interface, "platform", None),
            "chipTemp": getattr(interface, "cpu_temp", None),
            "csma": {
                "cwBand": getattr(interface, "r_csma_cw_band", None),
                "cwMin": getattr(interface, "r_csma_cw_min", None),
                "cwMax": getattr(interface, "r_csma_cw_max", None),
            },
            "phy": {
                "symbolTimeMs": getattr(interface, "r_symbol_time_ms", None),
                "symbolRate": getattr(interface, "r_symbol_rate", None),
                "preambleSymbols": getattr(interface, "r_preamble_symbols", None),
                "preambleTimeMs": getattr(interface, "r_premable_time_ms", None),
                "csmaSlotTimeMs": getattr(interface, "r_csma_slot_time_ms", None),
                "csmaDifsMs": getattr(interface, "r_csma_difs_ms", None),
            },
        }

    # -- probe / remote status (Phase 4, build spec §2.B/§2.C, #3960 WP2) ------
    # Neither method is mode-gated (unlike the own-mode radio family above):
    # both are valid in own/attach/tcp_peer alike, since all three modes
    # hold a live RNS instance. Both go through self._probe_backend (see
    # `_RNSProbeBackend`'s docstring for the exact RNS API this pins, and
    # why it's a swappable seam rather than direct RNS.* calls).

    @staticmethod
    def _parse_destination_hash(destination_hash_hex: Optional[str]) -> bytes:
        if not destination_hash_hex:
            raise ValueError("destinationHash is required")
        try:
            return bytes.fromhex(destination_hash_hex)
        except (TypeError, ValueError) as e:
            raise ValueError(f"invalid destination hash {destination_hash_hex!r}: {e}") from e

    def _resolve_path(self, destination_hash: bytes, deadline: float) -> bool:
        """Shared path-resolution poll loop (build spec §2.B: "resolves the
        path via RNS.Transport.request_path if unknown, reusing the
        existing request_path call site") -- same pattern as
        send_lxmf()'s unknown-identity wait above, generalized to a
        caller-supplied deadline instead of the LXMF-specific timeout
        constant."""
        if self._probe_backend.has_path(destination_hash):
            return True
        self._probe_backend.request_path(destination_hash)
        while not self._probe_backend.has_path(destination_hash) and time.monotonic() < deadline:
            time.sleep(LXMF_PATH_WAIT_POLL_S)
        return self._probe_backend.has_path(destination_hash)

    def probe(self, destination_hash_hex: Optional[str], timeout_s: Optional[float] = None) -> dict:
        """rnprobe-style reachability probe (build spec §2.B) against the
        target's built-in `rnstransport.probe` destination (RNS.Transport,
        PROVE_ALL -- see `_RNSProbeBackend`'s docstring for why this,
        rather than an arbitrary app destination, is the only thing
        genuinely probable from just a destinationHash). Returns
        `{ok, rttMs, hops}`. `ok=False` (NOT an exception) covers "no path"
        and "no proof within timeout" -- both normal, expected outcomes for
        an unreachable node, matching rnprobe's own timeout behavior.
        Raises for anything else (malformed hash, unexpected RNS-layer
        exception) -- ws_server.py's `_handle_probe` catches broadly and
        reports PROBE_FAILED, same "exception-wrapped -> error" contract as
        the Phase 2 LXMF command handlers."""
        timeout = timeout_s if timeout_s is not None else DEFAULT_PROBE_TIMEOUT_S
        destination_hash = self._parse_destination_hash(destination_hash_hex)
        deadline = time.monotonic() + timeout

        if not self._resolve_path(destination_hash, deadline):
            return {"ok": False, "rttMs": None, "hops": None, "error": "no path to destination"}

        identity = self._probe_backend.recall_identity(destination_hash)
        if identity is None:
            return {"ok": False, "rttMs": None, "hops": None, "error": "identity for destination is unknown"}

        receipt = self._probe_backend.send_probe(identity)

        while receipt.status == RNS.PacketReceipt.SENT and time.monotonic() < deadline:
            time.sleep(LXMF_PATH_WAIT_POLL_S)

        if receipt.status != RNS.PacketReceipt.DELIVERED:
            return {"ok": False, "rttMs": None, "hops": None, "error": "probe timed out"}

        rtt_s = receipt.get_rtt()
        return {
            "ok": True,
            "rttMs": round(rtt_s * 1000, 3) if rtt_s is not None else None,
            "hops": self._probe_backend.hops_to(destination_hash),
            "error": None,
        }

    def _wait_for_link_active(self, link: Any, deadline: float) -> bool:
        while time.monotonic() < deadline:
            status = getattr(link, "status", None)
            if status == RNS.Link.ACTIVE:
                return True
            if status == RNS.Link.CLOSED:
                return False
            time.sleep(LXMF_PATH_WAIT_POLL_S)
        return getattr(link, "status", None) == RNS.Link.ACTIVE

    @staticmethod
    def _wait_for_request(receipt: Any, deadline: float) -> Optional[Any]:
        if receipt is None or receipt is False:
            return None
        while not receipt.concluded() and time.monotonic() < deadline:
            time.sleep(LXMF_PATH_WAIT_POLL_S)
        return receipt.get_response()

    def get_remote_status(self, destination_hash_hex: Optional[str], timeout_s: Optional[float] = None) -> dict:
        """Queries a remote Transport Node's built-in
        `rnstransport.remote.management` destination (build spec §2.C) for
        /status and /path over an RNS.Link + Link.request(). The target
        must have `enable_remote_management` on AND our identity's hash
        present in ITS `remote_management_allowed` allowlist (their config,
        entirely invisible to us -- our side's RNS_REMOTE_ALLOWED,
        config.py, only gates which hashes Node is allowed to ask THIS
        bridge to query, enforced at the route/manager layer, not here).

        Returns `{ok, status, path}` for the "reached but nothing useful
        yet" and success cases. `ok=False` covers "no path" and "link never
        established" -- both a normal response, not a failure (network-
        level, could just mean the node is offline). Once the LINK itself
        establishes (proving the target is alive) but BOTH /status and
        /path fail to conclude, that's the best available signal for
        "denied": RNS's ALLOW_LIST request-handler gate never sends an
        explicit denial on the wire (verified against the vendored
        RNS/Link.py -- a request simply never gets a `response_received()`
        callback), so a genuine timeout and an allowlist rejection are
        indistinguishable at the protocol level. This method raises
        RemoteManagementDeniedError in that case; ws_server.py maps it to
        the typed REMOTE_MANAGEMENT_DENIED error. Any other exception
        (malformed hash, unexpected RNS-layer failure) propagates and is
        mapped to the generic REMOTE_STATUS_FAILED."""
        timeout = timeout_s if timeout_s is not None else DEFAULT_REMOTE_STATUS_TIMEOUT_S
        destination_hash = self._parse_destination_hash(destination_hash_hex)
        # Build spec §2.C / R5: RNS_REMOTE_ALLOWED is OUR identity-ACL on
        # the querying side -- which hashes THIS bridge is permitted to ask
        # about at all, checked BEFORE any network I/O. Empty allowlist
        # (the default) means no restriction here; enforcement is left to
        # the caller/route layer in that case.
        if self.cfg.remote_allowed and destination_hash_hex.strip().lower() not in self.cfg.remote_allowed:
            raise ValueError(f"destination {destination_hash_hex!r} is not in RNS_REMOTE_ALLOWED")
        deadline = time.monotonic() + timeout

        if not self._resolve_path(destination_hash, deadline):
            return {"ok": False, "status": None, "path": None, "error": "no path to remote management destination"}

        identity = self._probe_backend.recall_identity(destination_hash)
        if identity is None:
            return {
                "ok": False,
                "status": None,
                "path": None,
                "error": "identity for remote management destination is unknown",
            }

        link = self._probe_backend.open_management_link(identity)
        if not self._wait_for_link_active(link, deadline):
            return {
                "ok": False,
                "status": None,
                "path": None,
                "error": "link to remote management destination did not establish",
            }

        # data payloads match RNS.Transport's own remote_status_handler/
        # remote_path_handler contract exactly (verified against the
        # vendored rns==1.4.2 source -- both silently return None
        # server-side for non-list/malformed `data`): [True] for /status
        # requests the link count alongside interface stats; ["table"] is
        # /path's "give me the full path table" command.
        status_receipt = self._probe_backend.link_request(
            link, "/status", [True], max(deadline - time.monotonic(), 0.1)
        )
        path_receipt = self._probe_backend.link_request(
            link, "/path", ["table"], max(deadline - time.monotonic(), 0.1)
        )
        raw_status = self._wait_for_request(status_receipt, deadline)
        raw_path = self._wait_for_request(path_receipt, deadline)

        if raw_status is None and raw_path is None:
            raise RemoteManagementDeniedError(
                "remote management link established but /status and /path both failed to conclude "
                "(likely not on the remote's remote_management_allowed allowlist)"
            )

        return {
            "ok": True,
            "status": self._normalize_remote_status(raw_status),
            "path": self._normalize_remote_path(raw_path),
            "error": None,
        }

    @staticmethod
    def _normalize_remote_status(raw: Any) -> Optional[dict]:
        """Normalizes the raw `[interface_stats_dict, link_count?]` list
        RNS.Transport.remote_status_handler returns (build spec §2.C, /status
        with `data=[True]`) into the SAME `{name,type,hash,mode,status,
        online,bitrate,txBytes,rxBytes}` per-interface shape
        `get_interface_stats()`/`_normalize_interface()` already use for
        THIS bridge's own interfaces (WP0 correction #2's plumbing-interface
        filter applies here too), plus an optional `linkCount`."""
        if not isinstance(raw, list) or not raw:
            return None
        interfaces_raw = raw[0] if isinstance(raw[0], dict) else {}
        interfaces = interfaces_raw.get("interfaces", []) if isinstance(interfaces_raw, dict) else []
        result: dict = {
            "interfaces": [
                _normalize_interface(i) for i in interfaces if i.get("type") not in EXCLUDED_INTERFACE_TYPES
            ]
        }
        if len(raw) > 1:
            result["linkCount"] = raw[1]
        return result

    @staticmethod
    def _normalize_remote_path(raw: Any) -> Optional[list]:
        """Normalizes the raw path-table rows RNS.Transport.remote_path_handler
        returns (build spec §2.C, /path with `data=["table"]`) using the
        SAME `_normalize_path()` this bridge already applies to its OWN path
        table in `refresh_path_table()` -- identical row shape
        (`hash`/`via`/`hops`/`expires`/`interface`) on both sides."""
        if not isinstance(raw, list):
            return None
        return [_normalize_path(e) for e in raw if isinstance(e, dict)]

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
        result: dict = {
            "mode": self._effective_mode,
            "connected": connected,
            "rnsVersion": getattr(RNS, "__version__", None),
            "interfaceCount": interface_count,
        }
        # Build spec §3.4: surface the source's PUBLIC LXMF destination hash
        # once the Phase 2 router has started, so Node can persist it.
        if self.delivery_destination is not None:
            result["destinationHash"] = _hexlify(self.delivery_destination.hash)
        return result
