"""Single source of truth for the content of bridge/tests/fixtures/*.json.

Two consumers import from here, deliberately kept as thin as possible so they
can't drift from each other:

  - test_protocol.py: asserts the checked-in fixtures/*.json still match
    `build_fixture()`'s output (fails loudly if protocol.py's builders change
    without the fixtures being regenerated).
  - generate_fixtures.py: the fix-it counterpart -- (re)writes fixtures/*.json
    from the same `build_fixture()` calls.

If you change a builder function's *arguments* here, run
`python bridge/tests/generate_fixtures.py` and commit the resulting diff in
the same change. The Node-side contract test (src/server/reticulumBridgeClient
.test.ts, WP3) parses these files directly, so this is the actual Python<->
TypeScript wire contract, not just an internal Python fixture.
"""

from __future__ import annotations

from meshmonitor_rns_bridge import protocol

EXPECTED_FIXTURE_NAMES = {
    "welcome",
    "error",
    "ready",
    "announce",
    "announce_no_signal",
    "interface_stats",
    "path_table",
    "status",
    "hello",
    "configure",
    "get_status",
}

# Frozen envelope timestamp so regenerated fixtures are byte-stable across
# runs/machines (protocol.now_ms() is monkeypatched to this in both
# test_protocol.py's `frozen_now` fixture and generate_fixtures.py).
FIXED_TS = 1755000000000


def build_fixture(name: str) -> dict:
    """Rebuild a fixture's envelope from the live protocol builders, so
    drift between protocol.py and the checked-in golden JSON is caught
    (test_protocol.py) or fixed (generate_fixtures.py) from one definition."""
    if name == "welcome":
        return protocol.welcome_message(bridge_version="0.1.0", rns_version="1.4.2")
    if name == "error":
        return protocol.error_message(
            protocol.RPC_AUTH_FAILED,
            "rpc_key mismatch: digest sent was rejected by the shared instance",
            id="c1",
        )
    if name == "ready":
        return protocol.ready_message(id="c1")
    if name == "announce":
        return protocol.announce_message(
            destination_hash="a1b2c3d4e5f60718293a4b5c6d7e8f90",
            identity_hash="0f1e2d3c4b5a69788796a5b4c3d2e1f0",
            app_name="lxmf",
            aspects=["delivery"],
            display_name="Alice",
            app_data_b64="k6VBbGljZaA=",
            hops=2,
            next_hop_interface="TCP Server Interface",
            rssi=-97,
            snr=6.5,
            q=48,
            is_path_response=False,
        )
    if name == "announce_no_signal":
        return protocol.announce_message(
            destination_hash="112233445566778899aabbccddeeff0",
            identity_hash=None,
            app_name=None,
            aspects=None,
            display_name=None,
            app_data_b64=None,
            hops=None,
            next_hop_interface=None,
            rssi=None,
            snr=None,
            q=None,
            is_path_response=True,
        )
    if name == "interface_stats":
        return protocol.interface_stats_message(
            [
                {
                    "name": "TCP Server Interface",
                    "type": "TCPServerInterface",
                    "hash": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
                    "mode": "full",
                    "status": "up",
                    "online": True,
                    "bitrate": None,
                    "txBytes": 603,
                    "rxBytes": 362,
                },
                {
                    "name": "tcp_peer_127.0.0.1_4242",
                    "type": "TCPClientInterface",
                    "hash": None,
                    "mode": "full",
                    "status": "down",
                    "online": False,
                    "bitrate": None,
                    "txBytes": 0,
                    "rxBytes": 0,
                },
            ]
        )
    if name == "path_table":
        return protocol.path_table_message(
            [
                {
                    "destinationHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
                    "via": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
                    "hops": 1,
                    "expires": 1755001800.0,
                    "interface": "TCP Server Interface",
                }
            ]
        )
    if name == "status":
        return protocol.status_message(
            id="c2", mode="attach", connected=True, rnsVersion="1.4.2", interfaceCount=2
        )
    if name == "hello":
        return protocol.hello_message(token="change-me")
    if name == "configure":
        return protocol.configure_message(mode="attach", id="c0", config_dir="/rns", peers=None)
    if name == "get_status":
        return protocol.get_status_message(id="c2")
    raise ValueError(f"no builder registered for fixture {name!r}")
