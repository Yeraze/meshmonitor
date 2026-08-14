"""Environment-driven configuration for the bridge (build spec §4.1/§4.3).

No config file of our own -- everything comes from the process environment,
matching how the sidecar image is meant to be run (Docker/Helm/compose set
env vars, not mounted config).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping, Optional

from . import protocol

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8765
DEFAULT_STATS_INTERVAL_S = 5.0
DEFAULT_PATHS_INTERVAL_S = 15.0
DEFAULT_LOG_LEVEL = "info"
DEFAULT_MODE = "attach"

VALID_MODES = ("attach", "tcp_peer", "own")


def _default_lxmf_storage_dir() -> str:
    """Default LXMF_STORAGE_DIR (build spec §3.4, R5): under the process's
    writable home, NOT under RNS_CONFIG_DIR -- that dir is frequently a
    read-only bind mount of the operator's own `~/.reticulum` in attach mode
    (see docker-compose.reticulum.yml), so the LXMF identity/message-store
    needs a separate, always-writable location. `HOME` is set explicitly in
    the bridge's Dockerfile (`/home/bridge`) for exactly this kind of need.
    The identity file that lives here is the ONLY copy of the source's LXMF
    private key (R5) -- operators MUST persist this directory as a volume or
    a fresh container regenerates the identity (new LXMF address)."""
    return os.path.join(os.path.expanduser("~"), "lxmf-storage")


class ConfigError(Exception):
    """Raised for invalid/missing configuration at startup."""


@dataclass(frozen=True)
class TcpPeer:
    host: str
    port: int


@dataclass(frozen=True)
class BridgeConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    token: str = ""
    mode: str = DEFAULT_MODE
    rns_config_dir: Optional[str] = None
    tcp_peers: tuple = field(default_factory=tuple)
    protocol_version: int = protocol.PROTOCOL_VERSION
    stats_interval_s: float = DEFAULT_STATS_INTERVAL_S
    paths_interval_s: float = DEFAULT_PATHS_INTERVAL_S
    log_level: str = DEFAULT_LOG_LEVEL
    lxmf_storage_dir: str = field(default_factory=_default_lxmf_storage_dir)
    # Phase 3 (#3960 WP1, build spec §2.B): own mode -- the bridge owns the
    # RNode radio directly via RNS.Interfaces.RNodeInterface on `own_device`
    # (e.g. /dev/ttyUSB0). Only `own_device` is required; the radio params
    # below are the INITIAL values applied at interface construction --
    # None means "let RNodeInterface use its own defaults" (0 for
    # frequency/bandwidth/txpower/sf/cr, unset for the airtime locks). All
    # of these are also settable afterwards via the `set_radio_config`
    # command (ws_server.py), which is the normal path once own mode is
    # already running.
    own_device: Optional[str] = None
    own_frequency: Optional[int] = None
    own_bandwidth: Optional[int] = None
    own_sf: Optional[int] = None
    own_cr: Optional[int] = None
    own_txpower: Optional[int] = None
    own_st_alock: Optional[float] = None
    own_lt_alock: Optional[float] = None


def _parse_tcp_peers(raw: Optional[str]) -> tuple:
    if not raw:
        return ()
    peers = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if ":" not in chunk:
            raise ConfigError(f"invalid RNS_TCP_PEERS entry {chunk!r}, expected host:port")
        host, _, port_s = chunk.rpartition(":")
        if not host:
            raise ConfigError(f"invalid RNS_TCP_PEERS entry {chunk!r}, missing host")
        try:
            port = int(port_s)
        except ValueError as e:
            raise ConfigError(f"invalid port in RNS_TCP_PEERS entry {chunk!r}") from e
        peers.append(TcpPeer(host=host, port=port))
    return tuple(peers)


def _parse_int(raw: Optional[str], name: str, default: int) -> int:
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from e


def _parse_float(raw: Optional[str], name: str, default: float) -> float:
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from e


def _parse_optional_int(raw: Optional[str], name: str) -> Optional[int]:
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from e


def _parse_optional_float(raw: Optional[str], name: str) -> Optional[float]:
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except ValueError as e:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from e


def load_config(env: Optional[Mapping[str, str]] = None) -> BridgeConfig:
    """Parse BridgeConfig from an environment mapping (defaults to os.environ).

    `env` is typed as `Mapping[str, str]` rather than `dict` -- `os.environ` is an
    `os._Environ[str]`, not a `dict`, so a `dict | None` annotation here previously
    made pyright treat every `env.get(...)` call below as reportOptionalMemberAccess
    (the reassignment to `os.environ` didn't satisfy the declared `dict | None` type,
    so pyright kept `None` in the narrowed type). `Mapping[str, str]` is satisfied by
    both `os.environ` and a plain `dict[str, str]` (e.g. from tests), and this
    function only ever reads via `.get()`, never mutates -- read-only is the correct,
    narrower contract anyway.

    Env vars (build spec §4.1 module-layout comment):
      BRIDGE_HOST, BRIDGE_PORT, BRIDGE_TOKEN, RNS_CONFIG_DIR,
      RNS_MODE (attach|tcp_peer|own), RNS_TCP_PEERS, PROTOCOL_VERSION
    Plus poller cadence / logging (build spec §4.2, attach spec §4.3 defaults):
      BRIDGE_STATS_INTERVAL_S (default 5), BRIDGE_PATHS_INTERVAL_S (default 15),
      BRIDGE_LOG_LEVEL (default info).
    Phase 2 (LXMF messaging, build spec §3.4): LXMF_STORAGE_DIR (default
      under the writable home dir -- see `_default_lxmf_storage_dir()`).
    Phase 3 (own mode + RNode radio config, build spec §2.B, #3960 WP1):
      RNS_OWN_DEVICE (required when RNS_MODE=own, e.g. /dev/ttyUSB0),
      RNS_OWN_FREQUENCY, RNS_OWN_BANDWIDTH, RNS_OWN_SF, RNS_OWN_CR,
      RNS_OWN_TXPOWER, RNS_OWN_ST_ALOCK, RNS_OWN_LT_ALOCK (all optional
      initial radio params -- see `own_radio_params()`).
    """
    env = os.environ if env is None else env

    token = env.get("BRIDGE_TOKEN")
    if not token:
        raise ConfigError("BRIDGE_TOKEN is required (shared secret for hello handshake)")

    mode = env.get("RNS_MODE", DEFAULT_MODE)
    if mode not in VALID_MODES:
        raise ConfigError(f"RNS_MODE must be one of {VALID_MODES}, got {mode!r}")

    tcp_peers = _parse_tcp_peers(env.get("RNS_TCP_PEERS"))
    if mode == "tcp_peer" and not tcp_peers:
        raise ConfigError("RNS_TCP_PEERS is required when RNS_MODE=tcp_peer")

    own_device = env.get("RNS_OWN_DEVICE") or None
    if mode == "own" and not own_device:
        raise ConfigError("RNS_OWN_DEVICE is required when RNS_MODE=own")

    protocol_version = _parse_int(
        env.get("PROTOCOL_VERSION"), "PROTOCOL_VERSION", protocol.PROTOCOL_VERSION
    )

    return BridgeConfig(
        host=env.get("BRIDGE_HOST", DEFAULT_HOST),
        port=_parse_int(env.get("BRIDGE_PORT"), "BRIDGE_PORT", DEFAULT_PORT),
        token=token,
        mode=mode,
        rns_config_dir=env.get("RNS_CONFIG_DIR") or None,
        tcp_peers=tcp_peers,
        protocol_version=protocol_version,
        stats_interval_s=_parse_float(
            env.get("BRIDGE_STATS_INTERVAL_S"), "BRIDGE_STATS_INTERVAL_S", DEFAULT_STATS_INTERVAL_S
        ),
        paths_interval_s=_parse_float(
            env.get("BRIDGE_PATHS_INTERVAL_S"), "BRIDGE_PATHS_INTERVAL_S", DEFAULT_PATHS_INTERVAL_S
        ),
        log_level=env.get("BRIDGE_LOG_LEVEL", DEFAULT_LOG_LEVEL),
        lxmf_storage_dir=env.get("LXMF_STORAGE_DIR") or _default_lxmf_storage_dir(),
        own_device=own_device,
        own_frequency=_parse_optional_int(env.get("RNS_OWN_FREQUENCY"), "RNS_OWN_FREQUENCY"),
        own_bandwidth=_parse_optional_int(env.get("RNS_OWN_BANDWIDTH"), "RNS_OWN_BANDWIDTH"),
        own_sf=_parse_optional_int(env.get("RNS_OWN_SF"), "RNS_OWN_SF"),
        own_cr=_parse_optional_int(env.get("RNS_OWN_CR"), "RNS_OWN_CR"),
        own_txpower=_parse_optional_int(env.get("RNS_OWN_TXPOWER"), "RNS_OWN_TXPOWER"),
        own_st_alock=_parse_optional_float(env.get("RNS_OWN_ST_ALOCK"), "RNS_OWN_ST_ALOCK"),
        own_lt_alock=_parse_optional_float(env.get("RNS_OWN_LT_ALOCK"), "RNS_OWN_LT_ALOCK"),
    )


def own_radio_params(cfg: BridgeConfig) -> dict:
    """Builds the `{frequency,bandwidth,sf,cr,txpower,st_alock,lt_alock}`
    dict `RNSManager._start_own()` / `_build_rnode_ifconf()` expect, from
    the individual `BridgeConfig.own_*` fields -- keeps the env-var-driven
    defaults (this function) and the Node `configure` message's own-mode
    fields (`ws_server.py`'s `_parse_own_params`) shaped identically, so
    `RNSManager.start()` can treat them the same way regardless of source."""
    params: dict = {}
    if cfg.own_frequency is not None:
        params["frequency"] = cfg.own_frequency
    if cfg.own_bandwidth is not None:
        params["bandwidth"] = cfg.own_bandwidth
    if cfg.own_sf is not None:
        params["sf"] = cfg.own_sf
    if cfg.own_cr is not None:
        params["cr"] = cfg.own_cr
    if cfg.own_txpower is not None:
        params["txpower"] = cfg.own_txpower
    if cfg.own_st_alock is not None:
        params["st_alock"] = cfg.own_st_alock
    if cfg.own_lt_alock is not None:
        params["lt_alock"] = cfg.own_lt_alock
    return params
