"""Wire protocol v1 for the meshmonitor-rns-bridge <-> Node WebSocket link.

Envelope shape (build spec doc #3960, RETICULUM_PHASE1A_BUILD_SPEC.md §4.4):

    {"v": 1, "type": <str>, "id"?: <str>, "ts": <epoch_ms>, ...fields}

This module intentionally supersedes the older `{t, snake_case}` sketch in
RETICULUM_ATTACH_PHASE1_SPEC.md: the build spec's `{v, type, camelCase}`
envelope is the one implemented on both sides. The golden fixtures under
`bridge/tests/fixtures/` are the single source of truth for the Node-side
(WP3) contract test -- keep this module and those fixtures in lockstep.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterable, Optional

PROTOCOL_VERSION = 1

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


def ready_message(id: Optional[str] = None) -> dict:
    return envelope(TYPE_READY, id=id)


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
) -> dict:
    fields: dict = {"mode": mode}
    if config_dir is not None:
        fields["configDir"] = config_dir
    if peers is not None:
        fields["peers"] = peers
    return envelope(TYPE_CONFIGURE, id=id, **fields)


def get_status_message(id: str) -> dict:
    return envelope(TYPE_GET_STATUS, id=id)
