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
    # Phase 2 (LXMF messaging, #3960 WP1) -- build spec §3.6.
    "lxmf_message",
    "lxmf_message_no_signal",
    "delivery_state",
    "send_lxmf",
    "send_lxmf_response",
    "set_display_name",
    "sync_propagation",
    # Phase 3 (own mode + RNode radio config/device info, #3960 WP1) -- build
    # spec §2.C.
    "get_radio_config",
    "radio_config",
    "set_radio_config",
    "get_device_info",
    "device_info",
    # Phase 3 (Sideband FIELD_TELEMETRY decode, #3960 WP2) -- build spec §2.C.
    "telemetry",
}

# Fixture-directory stems that exist under tests/fixtures/*.json but are NOT
# protocol envelopes -- they don't go through build_fixture()/protocol.py's
# message builders, so test_protocol.py's exact-set assertion
# (test_fixture_directory_has_exactly_the_expected_files) and
# generate_fixtures.py's pruning both need to know about them separately
# from EXPECTED_FIXTURE_NAMES (which test_fixture_matches_live_builder_output
# parametrizes over, calling build_fixture() for each name -- there is no
# builder for these, by design).
#
# "sideband_telemetry_location_battery_temp.expected" (#3960 Phase 3 WP0/WP2,
# docs/internal/dev-notes/RETICULUM_WP0_PHASE3_SPIKE_EVIDENCE.md §5): the
# golden expected-decode JSON for sideband_telemetry.decode_field_telemetry(),
# paired with the sibling .bin fixture (not *.json, so it never enters
# on_disk in the first place).
NON_PROTOCOL_FIXTURE_STEMS = {
    "sideband_telemetry_location_battery_temp.expected",
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
    # Phase 2 (LXMF messaging, #3960 WP1) -- build spec §3.6.
    if name == "lxmf_message":
        return protocol.lxmf_message_event(
            hash="1a2b3c4d5e6f708192a3b4c5d6e7f809",
            from_hash="a1b2c3d4e5f60718293a4b5c6d7e8f90",
            to_hash="112233445566778899aabbccddeeff0",
            title="Hello",
            content="Hello from the WP1 spike!",
            # Already-sanitized shape (rns_manager.py's _sanitize_lxmf_fields
            # output) -- string field names, short byte values hex-encoded,
            # no raw attachment bytes (R3). See rns_manager.py's _FIELD_NAMES.
            fields={
                "thread": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
                "replyTo": "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
                "renderer": 1,  # RENDERER_MICRON
            },
            method="opportunistic",
            signature_validated=True,
            ratcheted=True,
            rssi=-97,
            snr=6.5,
            q=48,
        )
    if name == "lxmf_message_no_signal":
        # Models the realistic dual-rnsd/TCP-loopback delivery this bridge's
        # own integration test exercises: no RF hop means rssi/snr/q are
        # always None (WP0 §6.3), method is still known, ratchets haven't
        # been established yet on a first exchange.
        return protocol.lxmf_message_event(
            hash="2b3c4d5e6f708192a3b4c5d6e7f8091a",
            from_hash="b2c3d4e5f60718293a4b5c6d7e8f90a1",
            to_hash="2233445566778899aabbccddeeff011",
            title="Hello",
            content="Hello over TCP loopback",
            fields={},
            method="opportunistic",
            signature_validated=True,
            ratcheted=False,
            rssi=None,
            snr=None,
            q=None,
        )
    if name == "delivery_state":
        return protocol.delivery_state_event(
            hash="1a2b3c4d5e6f708192a3b4c5d6e7f809",
            state="delivered",
            method="opportunistic",
            attempts=1,
        )
    if name == "send_lxmf":
        return protocol.send_lxmf_message(
            to="112233445566778899aabbccddeeff0",
            title="Hello",
            content="Hello from the WP1 spike!",
            fields=None,
            method="opportunistic",
            propagation_node=None,
            id="c3",
        )
    if name == "send_lxmf_response":
        # The bridge's reply to `send_lxmf` IS a `delivery_state` envelope
        # (state="sending"), echoing the request id and carrying the
        # freshly-assigned LXM hash -- see ws_server.py's _handle_send_lxmf.
        return protocol.delivery_state_event(
            hash="1a2b3c4d5e6f708192a3b4c5d6e7f809",
            state="sending",
            method="opportunistic",
            attempts=0,
            id="c3",
        )
    if name == "set_display_name":
        return protocol.set_display_name_message(display_name="Alice", id="c4")
    if name == "sync_propagation":
        return protocol.sync_propagation_message(id="c5")
    # Phase 3 (own mode + RNode radio config/device info, #3960 WP1) -- build
    # spec §2.C.
    if name == "get_radio_config":
        return protocol.get_radio_config_message(id="c10")
    if name == "radio_config":
        return protocol.radio_config_message(
            id="c10",
            frequency=914875000,
            bandwidth=125000,
            spreadingFactor=8,
            codingRate=5,
            txPower=17,
            stAlock=33.3,
            ltAlock=None,
            radioState=True,
        )
    if name == "set_radio_config":
        return protocol.set_radio_config_message(id="c11", frequency=915000000, txPower=20)
    if name == "get_device_info":
        return protocol.get_device_info_message(id="c12")
    if name == "device_info":
        return protocol.device_info_message(
            id="c12",
            firmwareVersion="1.52",
            mcu=0x1E,
            # Raw CMD_PLATFORM byte (RNSManager.get_device_info() passes
            # `interface.platform` through as-is, per rns_manager.py) --
            # 0x80 == RNS.Interfaces.RNodeInterface.KISS.PLATFORM_ESP32,
            # also `rnode_kiss.PLATFORM_ESP32`.
            platform=0x80,
            chipTemp=34,
            csma={"cwBand": 2, "cwMin": 3, "cwMax": 8},
            phy={
                "symbolTimeMs": 32.768,
                "symbolRate": 976,
                "preambleSymbols": 12,
                "preambleTimeMs": 393,
                "csmaSlotTimeMs": 15,
                "csmaDifsMs": 45,
            },
        )
    # Phase 3 (Sideband FIELD_TELEMETRY decode, #3960 WP2) -- build spec
    # §2.A/§2.C. Values mirror the WP0 golden decode fixture
    # (sideband_telemetry_location_battery_temp.expected.json) so the two
    # fixtures agree on what a real Sideband payload decodes to end-to-end.
    if name == "telemetry":
        return protocol.telemetry_event(
            source_hash="a1b2c3d4e5f60718293a4b5c6d7e8f90",
            destination_hash="112233445566778899aabbccddeeff0",
            sensors={
                "rns_battery": {"value": 82.5, "unit": "%"},
                "rns_temperature": {"value": 24.3, "unit": "c"},
            },
            location={
                "lat": 37.7749,
                "lon": -122.4194,
                "altitude": 15.5,
                "speed": 1.2,
                "bearing": 270.0,
                "accuracy": 8.5,
            },
            ts=1755123456,
        )
    raise ValueError(f"no builder registered for fixture {name!r}")
