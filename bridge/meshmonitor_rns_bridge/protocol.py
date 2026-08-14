"""Wire protocol v2 for the meshmonitor-rns-bridge <-> Node WebSocket link.

Envelope shape (build spec doc #3960, RETICULUM_PHASE1A_BUILD_SPEC.md §4.4):

    {"v": 2, "type": <str>, "id"?: <str>, "ts": <epoch_ms>, ...fields}

This module intentionally supersedes the older `{t, snake_case}` sketch in
RETICULUM_ATTACH_PHASE1_SPEC.md: the build spec's `{v, type, camelCase}`
envelope is the one implemented on both sides. The golden fixtures under
`bridge/tests/fixtures/` are the single source of truth for the Node-side
(WP3) contract test -- keep this module and those fixtures in lockstep.

Bumped 1->2 for Phase 2 (LXMF messaging, RETICULUM_PHASE2_BUILD_SPEC.md §3.1,
R4): a strict-equality, fail-closed handshake means a v1 Node talking to a v2
bridge (or vice versa) gets PROTOCOL_VERSION_MISMATCH rather than silently
missing the new LXMF event/command types -- bridge and Node ship in one
image, so skew should never happen outside a mid-upgrade race, and failing
loudly there is the correct behavior.

Bumped 2->3 for Phase 3 WP1 (own mode + RNode radio config/device info,
RETICULUM_PHASE3_BUILD_SPEC.md §2.B/§2.C, #3960): adds the `own`
ReticulumMode plus the get_radio_config/set_radio_config/get_device_info
command-response pairs. Same fail-closed rationale as the 1->2 bump above.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterable, Optional

PROTOCOL_VERSION = 3

# --------------------------------------------------------------------------
# Message types
# --------------------------------------------------------------------------

TYPE_HELLO = "hello"
TYPE_WELCOME = "welcome"
TYPE_ERROR = "error"
TYPE_CONFIGURE = "configure"
TYPE_READY = "ready"
TYPE_ANNOUNCE = "announce"
TYPE_INTERFACE_STATS = "interface_stats"
TYPE_PATH_TABLE = "path_table"
TYPE_GET_STATUS = "get_status"
TYPE_STATUS = "status"

# Phase 2 (LXMF messaging, build spec §3.1) -- events (bridge -> Node).
TYPE_LXMF_MESSAGE = "lxmf_message"
TYPE_DELIVERY_STATE = "delivery_state"

# Phase 2 -- commands (Node -> bridge).
TYPE_SEND_LXMF = "send_lxmf"
TYPE_ANNOUNCE_SELF = "announce_self"
TYPE_SET_DISPLAY_NAME = "set_display_name"
TYPE_SYNC_PROPAGATION = "sync_propagation"
TYPE_SET_PROPAGATION_NODE = "set_propagation_node"
TYPE_GET_IDENTITY = "get_identity"
TYPE_IMPORT_IDENTITY = "import_identity"

# Phase 3 (own mode + RNode radio config/device info, build spec §2.C,
# #3960 WP1) -- commands (Node -> bridge) and their responses (bridge ->
# Node). Only meaningful in `own` mode; attach/tcp_peer reject these with
# OWN_MODE_REQUIRED (see ws_server.py).
TYPE_GET_RADIO_CONFIG = "get_radio_config"
TYPE_RADIO_CONFIG = "radio_config"
TYPE_SET_RADIO_CONFIG = "set_radio_config"
TYPE_GET_DEVICE_INFO = "get_device_info"
TYPE_DEVICE_INFO = "device_info"

# --------------------------------------------------------------------------
# Failure codes (build spec §4.3 / §4.4)
# --------------------------------------------------------------------------

PROTOCOL_VERSION_MISMATCH = "PROTOCOL_VERSION_MISMATCH"
AUTH_FAILED = "AUTH_FAILED"
CONFIGDIR_UNREADABLE = "CONFIGDIR_UNREADABLE"
NO_SHARED_INSTANCE = "NO_SHARED_INSTANCE"
RPC_AUTH_FAILED = "RPC_AUTH_FAILED"
TCP_PEER_UNREACHABLE = "TCP_PEER_UNREACHABLE"
RNS_INIT_FAILED = "RNS_INIT_FAILED"
# Node-side only: the bridge never emits this (it means the WS socket never
# opened at all), documented here so both sides agree on the full code set.
BRIDGE_UNREACHABLE = "BRIDGE_UNREACHABLE"
# Phase 2: generic exception-wrapped failure for any of the new LXMF command
# handlers (send_lxmf/announce_self/set_display_name/sync_propagation/
# set_propagation_node/get_identity/import_identity) -- ws_server.py catches
# broadly and reports this rather than letting the connection die, per build
# spec §3.5 "exception-wrapped -> error".
LXMF_COMMAND_FAILED = "LXMF_COMMAND_FAILED"
# Phase 3 (own mode, build spec §2.B, #3960 WP1): get_radio_config/
# set_radio_config/get_device_info sent to a source that isn't running in
# `own` mode (no local RNodeInterface to read/configure) -- a TYPED error,
# distinct from the generic exception-wrapped RNODE_COMMAND_FAILED below,
# so Node can tell "wrong mode" apart from "the radio call itself failed".
OWN_MODE_REQUIRED = "OWN_MODE_REQUIRED"
# Phase 3: own mode's RNode device path is missing, unreadable, or the
# RNodeInterface failed to come online -- can originate from RNS instance
# startup (rns_manager.py's _start_own()), same as the other STARTUP_
# FAILURE_CODES below.
RNODE_DEVICE_UNAVAILABLE = "RNODE_DEVICE_UNAVAILABLE"
# Phase 3: generic exception-wrapped failure for get_radio_config/
# set_radio_config/get_device_info once own-mode-required has already been
# ruled out -- same "exception-wrapped -> error" contract as
# LXMF_COMMAND_FAILED, just for the radio-config command family.
RNODE_COMMAND_FAILED = "RNODE_COMMAND_FAILED"

FAILURE_CODES = frozenset(
    {
        PROTOCOL_VERSION_MISMATCH,
        AUTH_FAILED,
        CONFIGDIR_UNREADABLE,
        NO_SHARED_INSTANCE,
        RPC_AUTH_FAILED,
        TCP_PEER_UNREACHABLE,
        RNS_INIT_FAILED,
        BRIDGE_UNREACHABLE,
        LXMF_COMMAND_FAILED,
        OWN_MODE_REQUIRED,
        RNODE_DEVICE_UNAVAILABLE,
        RNODE_COMMAND_FAILED,
    }
)

# Failure codes that can originate from RNS instance startup (rns_manager.py).
# Subset of FAILURE_CODES, used to validate RNSStartupError.code at the call site.
STARTUP_FAILURE_CODES = frozenset(
    {
        CONFIGDIR_UNREADABLE,
        NO_SHARED_INSTANCE,
        RPC_AUTH_FAILED,
        TCP_PEER_UNREACHABLE,
        RNS_INIT_FAILED,
        RNODE_DEVICE_UNAVAILABLE,
    }
)


class ProtocolError(Exception):
    """Raised for malformed envelopes/messages on either side of decode()."""


def now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------
# Envelope encode/decode
# --------------------------------------------------------------------------


def envelope(type_: str, id: Optional[str] = None, **fields: Any) -> dict:
    """Build a v1 envelope dict. `fields` are merged in as top-level keys."""
    env: dict = {"v": PROTOCOL_VERSION, "type": type_, "ts": now_ms()}
    if id is not None:
        env["id"] = id
    env.update(fields)
    return env


def encode(env: dict) -> str:
    return json.dumps(env, separators=(",", ":"))


def decode(raw: "str | bytes") -> dict:
    """Parse and structurally validate a raw WS message into an envelope dict.

    Raises ProtocolError for anything that isn't a well-formed v1 envelope.
    Does NOT validate per-type required fields -- callers do that.
    """
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError, UnicodeDecodeError) as e:
        raise ProtocolError(f"invalid JSON: {e}") from e

    if not isinstance(obj, dict):
        raise ProtocolError("envelope must be a JSON object")
    if "type" not in obj or not isinstance(obj["type"], str):
        raise ProtocolError("envelope missing string 'type'")
    if "v" not in obj:
        raise ProtocolError("envelope missing 'v'")

    return obj


# --------------------------------------------------------------------------
# Server -> client message builders
# --------------------------------------------------------------------------


def welcome_message(bridge_version: str, rns_version: str) -> dict:
    return envelope(
        TYPE_WELCOME,
        protocolVersion=PROTOCOL_VERSION,
        bridgeVersion=bridge_version,
        rnsVersion=rns_version,
    )


def error_message(code: str, message: Optional[str] = None, id: Optional[str] = None) -> dict:
    fields: dict = {"code": code}
    if message is not None:
        fields["message"] = message
    return envelope(TYPE_ERROR, id=id, **fields)


def ready_message(id: Optional[str] = None, **fields: Any) -> dict:
    """`**fields` lets `_handle_configure` (ws_server.py) attach the source's
    PUBLIC LXMF destinationHash once Phase 2's LXMF router has started
    (build spec §3.4: "return the source's PUBLIC destination hash in
    ready/status so Node persists it") -- optional, so plain `ready_message(id=...)`
    is unchanged for Phase 1a callers."""
    return envelope(TYPE_READY, id=id, **fields)


def announce_message(
    *,
    destination_hash: str,
    identity_hash: Optional[str] = None,
    app_name: Optional[str] = None,
    aspects: Optional[Iterable[str]] = None,
    display_name: Optional[str] = None,
    app_data_b64: Optional[str] = None,
    hops: Optional[int] = None,
    next_hop_interface: Optional[str] = None,
    rssi: Optional[int] = None,
    snr: Optional[float] = None,
    q: Optional[int] = None,
    is_path_response: Optional[bool] = None,
) -> dict:
    return envelope(
        TYPE_ANNOUNCE,
        destinationHash=destination_hash,
        identityHash=identity_hash,
        appName=app_name,
        aspects=list(aspects) if aspects is not None else None,
        displayName=display_name,
        appDataB64=app_data_b64,
        hops=hops,
        nextHopInterface=next_hop_interface,
        rssi=rssi,
        snr=snr,
        q=q,
        isPathResponse=is_path_response,
    )


def interface_stats_message(interfaces: list) -> dict:
    return envelope(TYPE_INTERFACE_STATS, interfaces=interfaces)


def path_table_message(paths: list) -> dict:
    return envelope(TYPE_PATH_TABLE, paths=paths)


def status_message(id: Optional[str] = None, **fields: Any) -> dict:
    return envelope(TYPE_STATUS, id=id, **fields)


# --------------------------------------------------------------------------
# Client -> server message builders (used by tests / a reference client)
# --------------------------------------------------------------------------


def hello_message(token: str, protocol_version: int = PROTOCOL_VERSION) -> dict:
    return envelope(TYPE_HELLO, protocolVersion=protocol_version, token=token)


def configure_message(
    mode: str,
    id: Optional[str] = None,
    config_dir: Optional[str] = None,
    peers: Optional[list] = None,
    device: Optional[str] = None,
    frequency: Optional[int] = None,
    bandwidth: Optional[int] = None,
    spreading_factor: Optional[int] = None,
    coding_rate: Optional[int] = None,
    tx_power: Optional[int] = None,
    st_alock: Optional[float] = None,
    lt_alock: Optional[float] = None,
) -> dict:
    """`device` + the radio-param kwargs are Phase 3's own-mode addition
    (build spec §2.C: "Add 'own' to ... ConfigureMessage payload (device
    path + initial params)") -- all optional, and only meaningful when
    `mode == "own"`; omitted (not sent as null) when not provided, same
    convention as `config_dir`/`peers` above."""
    fields: dict = {"mode": mode}
    if config_dir is not None:
        fields["configDir"] = config_dir
    if peers is not None:
        fields["peers"] = peers
    if device is not None:
        fields["device"] = device
    if frequency is not None:
        fields["frequency"] = frequency
    if bandwidth is not None:
        fields["bandwidth"] = bandwidth
    if spreading_factor is not None:
        fields["spreadingFactor"] = spreading_factor
    if coding_rate is not None:
        fields["codingRate"] = coding_rate
    if tx_power is not None:
        fields["txPower"] = tx_power
    if st_alock is not None:
        fields["stAlock"] = st_alock
    if lt_alock is not None:
        fields["ltAlock"] = lt_alock
    return envelope(TYPE_CONFIGURE, id=id, **fields)


def get_status_message(id: str) -> dict:
    return envelope(TYPE_GET_STATUS, id=id)


# --------------------------------------------------------------------------
# Phase 2 (LXMF messaging): events, bridge -> Node (build spec §3.3)
# --------------------------------------------------------------------------


def lxmf_message_event(
    *,
    hash: str,
    from_hash: str,
    to_hash: str,
    title: Optional[str] = None,
    content: Optional[str] = None,
    fields: Optional[dict] = None,
    method: Optional[str] = None,
    signature_validated: bool = False,
    ratcheted: bool = False,
    rssi: Optional[int] = None,
    snr: Optional[float] = None,
    q: Optional[int] = None,
    id: Optional[str] = None,
) -> dict:
    """An inbound (or reflected outbound) LXMF message. `from`/`to` are
    reserved words in Python, so they're passed through a dict-unpack rather
    than `**kwargs` literal syntax -- still ordinary string keys on the wire.
    Field sanitation (R3: attachment metadata only, never raw bytes) is the
    caller's (rns_manager.py's) responsibility; this builder just shapes the
    envelope."""
    return envelope(
        TYPE_LXMF_MESSAGE,
        id=id,
        **{
            "hash": hash,
            "from": from_hash,
            "to": to_hash,
            "title": title,
            "content": content,
            "fields": fields if fields is not None else {},
            "method": method,
            "signatureValidated": signature_validated,
            "ratcheted": ratcheted,
            "rssi": rssi,
            "snr": snr,
            "q": q,
        },
    )


def delivery_state_event(
    *,
    hash: str,
    state: str,
    method: Optional[str] = None,
    attempts: Optional[int] = None,
    id: Optional[str] = None,
) -> dict:
    """A delivery-state transition for an outbound LXM. `state` is one of
    `sending|sent|delivered|failed` -- the bridge maps LXMF's numeric
    LXMessage state constants to this set in exactly one place
    (rns_manager.py's `_lxmf_state_to_wire`). Also doubles as the `send_lxmf`
    command's response (id=the request id, state="sending") -- see build
    spec §3.5."""
    return envelope(
        TYPE_DELIVERY_STATE,
        id=id,
        hash=hash,
        state=state,
        method=method,
        attempts=attempts,
    )


# --------------------------------------------------------------------------
# Phase 2 (LXMF messaging): commands, Node -> bridge (build spec §3.5)
# --------------------------------------------------------------------------


def send_lxmf_message(
    to: str,
    title: str = "",
    content: str = "",
    fields: Optional[dict] = None,
    method: Optional[str] = None,
    propagation_node: Optional[str] = None,
    id: Optional[str] = None,
) -> dict:
    fields_dict: dict = {"to": to, "title": title, "content": content}
    if fields is not None:
        fields_dict["fields"] = fields
    if method is not None:
        fields_dict["method"] = method
    if propagation_node is not None:
        fields_dict["propagationNode"] = propagation_node
    return envelope(TYPE_SEND_LXMF, id=id, **fields_dict)


def announce_self_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_ANNOUNCE_SELF, id=id)


def set_display_name_message(display_name: str, id: Optional[str] = None) -> dict:
    return envelope(TYPE_SET_DISPLAY_NAME, id=id, displayName=display_name)


def sync_propagation_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_SYNC_PROPAGATION, id=id)


def set_propagation_node_message(destination_hash: str, id: Optional[str] = None) -> dict:
    return envelope(TYPE_SET_PROPAGATION_NODE, id=id, destinationHash=destination_hash)


def get_identity_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_GET_IDENTITY, id=id)


def import_identity_message(private_key_b64: str, id: Optional[str] = None) -> dict:
    """Bridge-internal command only (R2): the private key travels over this
    trusted bridge<->Node WS link (guarded by BRIDGE_TOKEN), but there is
    deliberately NO Node HTTP route that exposes or accepts it -- see
    rns_manager.py's `import_identity` docstring and the build spec §3.4."""
    return envelope(TYPE_IMPORT_IDENTITY, id=id, privateKeyB64=private_key_b64)


# --------------------------------------------------------------------------
# Phase 3 (own mode + RNode radio config/device info, build spec §2.C,
# #3960 WP1): commands (Node -> bridge) and their responses (bridge ->
# Node). All free-form `**fields` passthrough (same pattern as
# `status_message` above) since `RNSManager.get_radio_config()` /
# `get_device_info()` already return dicts keyed exactly by these wire
# field names -- ws_server.py's handlers forward them directly rather than
# re-typing every key.
# --------------------------------------------------------------------------


def get_radio_config_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_GET_RADIO_CONFIG, id=id)


def radio_config_message(id: Optional[str] = None, **fields: Any) -> dict:
    """Fields (build spec §2.C): frequency, bandwidth, spreadingFactor,
    codingRate, txPower, stAlock, ltAlock, radioState. Doubles as the
    `set_radio_config` command's response (echoing the request `id`), same
    as `delivery_state_event` doubling as `send_lxmf`'s response above."""
    return envelope(TYPE_RADIO_CONFIG, id=id, **fields)


def set_radio_config_message(id: Optional[str] = None, **fields: Any) -> dict:
    """Partial radio-config write (build spec §2.C: "partial allowed"): any
    subset of radio_config_message's fields. Omitted keys mean "leave this
    parameter unchanged" -- `RNSManager.set_radio_config()`'s contract."""
    return envelope(TYPE_SET_RADIO_CONFIG, id=id, **fields)


def get_device_info_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_GET_DEVICE_INFO, id=id)


def device_info_message(id: Optional[str] = None, **fields: Any) -> dict:
    """Fields (build spec §2.C): firmwareVersion, mcu, platform, chipTemp,
    csma (dict), phy (dict)."""
    return envelope(TYPE_DEVICE_INFO, id=id, **fields)
