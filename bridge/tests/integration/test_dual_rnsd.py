"""Hardware-free CI integration tests: two real `rnsd` instances over
`TCPServerInterface`/`TCPClientInterface` on loopback, and a real bridge subprocess
attach-ing to one of them (build spec §5 / §9 test 1, attach spec §9).

WP0 correction #3 (spike evidence §6.4): `RNS.Reticulum()` is a process-wide
singleton -- a second construction in the same process raises an unrelated
'Attempt to reinitialise Reticulum' OSError that masks the real failure under test.
Every case here is isolated in its own OS subprocess (rnsd itself, the bridge, and
the announcer helper are all spawned via `subprocess`/rnsd_harness.py) -- pytest's own
process never calls `RNS.Reticulum()`, so this constraint is satisfied by construction
rather than by discipline at each test.

Skips (not fails) the whole module if the `rnsd` binary isn't on PATH, since it's only
installed as part of the `rns` package (requirements.txt) -- see bridge/README.md.
"""

from __future__ import annotations

import re
import shutil
import time

import pytest

from meshmonitor_rns_bridge import protocol

from .rnsd_harness import (
    BridgeProcess,
    RnsdServer,
    free_port,
    spawn_announcer,
    write_announcer_config,
    write_attach_only_config,
)
from .ws_test_client import BridgeClient

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(shutil.which("rnsd") is None, reason="rnsd not on PATH (install bridge/requirements.txt)"),
    pytest.mark.timeout(60),
]

TEST_TOKEN = "wp2-integration-test-token"
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")


def _bridge_env(**overrides) -> dict:
    env = {
        "BRIDGE_TOKEN": TEST_TOKEN,
        "RNS_MODE": "attach",
        "BRIDGE_STATS_INTERVAL_S": "0.5",
        "BRIDGE_PATHS_INTERVAL_S": "1",
        "BRIDGE_LOG_LEVEL": "debug",
    }
    env.update(overrides)
    return env


@pytest.fixture
def instance_a(tmp_path):
    server = RnsdServer(
        configdir=tmp_path / "rns_a",
        tcp_port=free_port(),
        rpc_port=free_port(),
        rpc_ctrl_port=free_port(),
    )
    server.start()
    yield server
    server.stop()


def _start_bridge(tmp_path, configdir, ws_port, **env_overrides) -> BridgeProcess:
    bridge = BridgeProcess(
        env=_bridge_env(
            BRIDGE_HOST="127.0.0.1",
            BRIDGE_PORT=str(ws_port),
            RNS_CONFIG_DIR=str(configdir),
            **env_overrides,
        )
    )
    bridge.start(ws_port)
    return bridge


# --------------------------------------------------------------------------
# Happy path: attach, interface_stats (filtered), announce from a second rnsd
# --------------------------------------------------------------------------


def test_attach_receives_filtered_interface_stats_and_announce(tmp_path, instance_a):
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            welcome = client.hello()
            assert welcome["type"] == protocol.TYPE_WELCOME
            assert welcome["protocolVersion"] == protocol.PROTOCOL_VERSION
            assert welcome["rnsVersion"]

            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY, ready

            # WP0 correction #2, verified live (not just via fixture): the real
            # TCPServerInterface must appear, RNS's own shared-instance plumbing
            # (LocalServerInterface / one LocalClientInterface per attached client,
            # including this bridge itself) must NOT.
            stats = client.recv_until(lambda e: e.get("type") == protocol.TYPE_INTERFACE_STATS)
            names = {i["type"] for i in stats["interfaces"]}
            assert "TCPServerInterface" in names
            assert "LocalServerInterface" not in names
            assert "LocalClientInterface" not in names
            tcp_iface = next(i for i in stats["interfaces"] if i["type"] == "TCPServerInterface")
            assert tcp_iface["online"] is True
            assert tcp_iface["status"] == "up"

            # Second rnsd (instance B) announces a destination; it must reach the
            # bridge over the WS with the right shape and hop count.
            announcer_dir = tmp_path / "rns_b"
            write_announcer_config(announcer_dir, target_port=instance_a.tcp_port)
            spawn_announcer(announcer_dir)

            announce = client.recv_until(lambda e: e.get("type") == protocol.TYPE_ANNOUNCE, timeout=20)
            assert HEX32_RE.match(announce["destinationHash"]), announce["destinationHash"]
            assert announce["hops"] is not None
            assert announce["hops"] >= 0
            # WP0 correction #4, verified live: no RF hop on TCP loopback -> None,
            # not some placeholder/zero value.
            assert announce["rssi"] is None
            assert announce["snr"] is None
            assert announce["q"] is None
    finally:
        bridge.stop()


def test_get_status_reports_connected_after_configure(tmp_path, instance_a):
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY

            status = client.get_status()
            assert status["connected"] is True
            assert status["mode"] == "attach"
            assert status["rnsVersion"]
    finally:
        bridge.stop()


# --------------------------------------------------------------------------
# tcp_peer mode (build spec §6 WP2 accept criteria: "both modes reach ready ...
# against a local rnsd (attach) and a local TCP peer (tcp_peer)")
# --------------------------------------------------------------------------


def test_tcp_peer_mode_reaches_ready_and_gets_interface_stats(tmp_path, instance_a):
    """The bridge runs its OWN standalone RNS instance (no shared instance, no
    RNS_CONFIG_DIR pointed at instance A's dir -- that dir is owned by the running
    rnsd A process) and connects out to instance A's TCPServerInterface as a
    TCPClientInterface peer, entirely via the `configure` message's `peers` field
    rather than env vars, per build spec §4.4."""
    ws_port = free_port()
    own_configdir = tmp_path / "bridge_own_rns"
    bridge = BridgeProcess(env=_bridge_env(BRIDGE_HOST="127.0.0.1", BRIDGE_PORT=str(ws_port)))
    bridge.start(ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            ready = client.configure(
                mode="tcp_peer",
                config_dir=str(own_configdir),
                peers=[{"host": "127.0.0.1", "port": instance_a.tcp_port}],
            )
            assert ready["type"] == protocol.TYPE_READY, ready

            status = client.get_status()
            assert status["mode"] == "tcp_peer"
            assert status["connected"] is True

            stats = client.recv_until(lambda e: e.get("type") == protocol.TYPE_INTERFACE_STATS, timeout=15)
            types = {i["type"] for i in stats["interfaces"]}
            assert "TCPClientInterface" in types
            iface = next(i for i in stats["interfaces"] if i["type"] == "TCPClientInterface")
            assert iface["online"] is True
    finally:
        bridge.stop()


def test_tcp_peer_mode_unreachable_peer_gives_tcp_peer_unreachable(tmp_path):
    ws_port = free_port()
    own_configdir = tmp_path / "bridge_own_rns_unreachable"
    unreachable_port = free_port()  # nothing listens here
    bridge = BridgeProcess(env=_bridge_env(BRIDGE_HOST="127.0.0.1", BRIDGE_PORT=str(ws_port)))
    bridge.start(ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            resp = client.configure(
                mode="tcp_peer",
                config_dir=str(own_configdir),
                peers=[{"host": "127.0.0.1", "port": unreachable_port}],
            )
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.TCP_PEER_UNREACHABLE
    finally:
        bridge.stop()


# --------------------------------------------------------------------------
# Handshake-level failures (no RNS involved)
# --------------------------------------------------------------------------


def test_wrong_token_gets_auth_failed(tmp_path, instance_a):
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", "wrong-token") as client:
            resp = client.hello()
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.AUTH_FAILED
    finally:
        bridge.stop()


def test_protocol_version_mismatch(tmp_path, instance_a):
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            resp = client.hello(protocol_version=999)
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.PROTOCOL_VERSION_MISMATCH
    finally:
        bridge.stop()


# --------------------------------------------------------------------------
# Failure-path case 1: rnsd absent
# --------------------------------------------------------------------------


def test_configdir_exists_but_no_rnsd_gives_no_shared_instance(tmp_path):
    """WP0 §5(b1): an EXISTING-but-never-attached-to configdir with no rnsd running
    bootstraps a fresh default config and then fails identically to 'no shared
    instance' -- this is the expected, documented NO_SHARED_INSTANCE case, distinct
    from a genuinely missing directory (see next test)."""
    configdir = tmp_path / "empty_but_present"
    configdir.mkdir()

    ws_port = free_port()
    bridge = _start_bridge(tmp_path, configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            resp = client.configure(mode="attach")
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.NO_SHARED_INSTANCE
    finally:
        bridge.stop()


def test_missing_configdir_gives_configdir_unreadable_not_no_shared_instance(tmp_path):
    """WP0 correction #1, direct test: a configdir that does not exist at all must be
    distinguished from NO_SHARED_INSTANCE by our explicit os.path.isdir() pre-check,
    since RNS itself cannot tell the two apart from inside the constructor."""
    configdir = tmp_path / "does_not_exist_at_all"
    assert not configdir.exists()

    ws_port = free_port()
    bridge = _start_bridge(tmp_path, configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            resp = client.configure(mode="attach")
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.CONFIGDIR_UNREADABLE
    finally:
        bridge.stop()


# --------------------------------------------------------------------------
# Failure-path case 2: rpc_key mismatch
# --------------------------------------------------------------------------


def test_mismatched_config_dir_gives_rpc_auth_failed(tmp_path, instance_a):
    """WP0 §5(c): pointing the bridge at a DIFFERENT config dir that shares instance
    A's shared-instance ports but has its own (different, RNS-derived) transport
    identity -- and therefore a different derived rpc_key -- attaches structurally
    (the packet-forwarding channel only depends on ifac, not rpc_key) but fails on the
    first authenticated RPC call, which our attach startup forces eagerly."""
    mismatched_dir = tmp_path / "rns_c_wrong_identity"
    write_attach_only_config(mismatched_dir, rpc_port=instance_a.rpc_port, rpc_ctrl_port=instance_a.rpc_ctrl_port)

    ws_port = free_port()
    bridge = _start_bridge(tmp_path, mismatched_dir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            resp = client.configure(mode="attach")
            assert resp["type"] == protocol.TYPE_ERROR
            assert resp["code"] == protocol.RPC_AUTH_FAILED
    finally:
        bridge.stop()


# --------------------------------------------------------------------------
# Failure-path case 3: rnsd restarts mid-session
# --------------------------------------------------------------------------


def test_rnsd_restart_mid_session_bridge_exits_then_reattaches_after_supervisor_restart(tmp_path, instance_a):
    """RNS.Reticulum has no supported in-process reattach (WP0 §6.4): the documented
    recovery path (attach spec §4.4: 'tear down and re-attach from scratch') is a
    fresh OS process. This test proves both halves: (a) the bridge's health monitor
    detects the dead RPC channel and exits non-zero rather than hanging or crashing
    uncleanly, and (b) after rnsd A and the bridge are both restarted fresh (what a
    process supervisor like `restart: unless-stopped` would do), the bridge reattaches
    and stats resume -- i.e. 'the poller recovers' means the system recovers, not that
    the same process silently self-heals.
    """
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port, BRIDGE_STATS_INTERVAL_S="0.3")
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY
            client.recv_until(lambda e: e.get("type") == protocol.TYPE_INTERFACE_STATS)

        # Kill rnsd A out from under the bridge's attached RPC connection.
        instance_a.stop()

        # The bridge's interface-stats poller (0.3s interval, 3-failure threshold)
        # should detect the dead channel within ~1-2s and exit non-zero.
        exit_code = bridge.wait_exit(timeout=15)
        assert exit_code == 1, bridge.output()
    finally:
        bridge.stop()

    # Bring instance A back up on the SAME config dir (same transport identity, same
    # ports) and start a fresh bridge process -- the supervisor-restart recovery path.
    instance_a.start()  # fixture teardown will stop() this fresh process too
    ws_port_2 = free_port()
    bridge2 = _start_bridge(tmp_path, instance_a.configdir, ws_port_2)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port_2}", TEST_TOKEN) as client:
            welcome = client.hello()
            assert welcome["type"] == protocol.TYPE_WELCOME
            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY
            stats = client.recv_until(lambda e: e.get("type") == protocol.TYPE_INTERFACE_STATS, timeout=15)
            assert any(i["type"] == "TCPServerInterface" for i in stats["interfaces"])
    finally:
        bridge2.stop()


# --------------------------------------------------------------------------
# Failure-path case 4: bridge restart (rnsd stays healthy throughout)
# --------------------------------------------------------------------------


def test_bridge_restart_reattaches_cleanly_while_rnsd_stays_up(tmp_path, instance_a):
    """Operator-initiated bridge restart, distinct from case 3's rnsd-side failure:
    proves the bridge is stateless beyond its RNS instance and a fresh process can
    always reattach to a healthy, still-running rnsd (README.md's claim, tested)."""
    ws_port = free_port()
    bridge = _start_bridge(tmp_path, instance_a.configdir, ws_port)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port}", TEST_TOKEN) as client:
            client.hello()
            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY
    finally:
        bridge.stop()

    assert bridge.poll() is not None  # confirm it actually exited

    ws_port_2 = free_port()
    bridge2 = _start_bridge(tmp_path, instance_a.configdir, ws_port_2)
    try:
        with BridgeClient(f"ws://127.0.0.1:{ws_port_2}", TEST_TOKEN) as client:
            welcome = client.hello()
            assert welcome["type"] == protocol.TYPE_WELCOME
            ready = client.configure(mode="attach")
            assert ready["type"] == protocol.TYPE_READY
            stats = client.recv_until(lambda e: e.get("type") == protocol.TYPE_INTERFACE_STATS, timeout=15)
            assert any(i["type"] == "TCPServerInterface" for i in stats["interfaces"])
    finally:
        bridge2.stop()
