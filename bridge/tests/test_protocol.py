"""Unit tests for meshmonitor_rns_bridge.protocol: envelope encode/decode, failure-code
round trips, and the golden fixtures under tests/fixtures/ that the TS contract test
(WP3) parses independently. If you change a builder function's output shape, update
this file's `_build_fixture()` map (or bridge/tests/fixtures/*.json directly) in the
same commit -- the fixtures are the single source of truth for the wire contract."""

from __future__ import annotations

import json

import pytest

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

FIXED_TS = 1755000000000


def _build_fixture(name: str) -> dict:
    """Rebuild a fixture's envelope from the live protocol builders, so this test
    fails loudly if protocol.py drifts from the checked-in golden JSON."""
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


@pytest.fixture
def frozen_now(monkeypatch):
    monkeypatch.setattr(protocol, "now_ms", lambda: FIXED_TS)


# --------------------------------------------------------------------------
# Envelope basics
# --------------------------------------------------------------------------


def test_envelope_has_v_type_ts():
    env = protocol.envelope("ready")
    assert env["v"] == protocol.PROTOCOL_VERSION
    assert env["type"] == "ready"
    assert isinstance(env["ts"], int)
    assert "id" not in env


def test_envelope_includes_id_when_given():
    env = protocol.envelope("ready", id="abc123")
    assert env["id"] == "abc123"


def test_envelope_merges_extra_fields():
    env = protocol.envelope("status", mode="attach", connected=True)
    assert env["mode"] == "attach"
    assert env["connected"] is True


# --------------------------------------------------------------------------
# encode/decode round trip
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(EXPECTED_FIXTURE_NAMES))
def test_encode_decode_roundtrip(name):
    env = _build_fixture(name)
    raw = protocol.encode(env)
    assert isinstance(raw, str)
    decoded = protocol.decode(raw)
    assert decoded == env


def test_encode_is_compact_json():
    env = protocol.ready_message(id="c1")
    raw = protocol.encode(env)
    # separators=(",", ":") -- no spaces after separators.
    assert ", " not in raw
    assert ": " not in raw


# --------------------------------------------------------------------------
# decode() validation
# --------------------------------------------------------------------------


def test_decode_rejects_non_json():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode("not json{{{")


def test_decode_rejects_non_object():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode(json.dumps([1, 2, 3]))


def test_decode_rejects_missing_type():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode(json.dumps({"v": 1}))


def test_decode_rejects_non_string_type():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode(json.dumps({"v": 1, "type": 42}))


def test_decode_rejects_missing_v():
    with pytest.raises(protocol.ProtocolError):
        protocol.decode(json.dumps({"type": "hello"}))


def test_decode_accepts_bytes_input():
    env = protocol.ready_message(id="c1")
    raw_bytes = protocol.encode(env).encode("utf-8")
    assert protocol.decode(raw_bytes) == env


# --------------------------------------------------------------------------
# Failure codes
# --------------------------------------------------------------------------


def test_failure_codes_are_unique_strings():
    assert len(protocol.FAILURE_CODES) == len(set(protocol.FAILURE_CODES))
    for code in protocol.FAILURE_CODES:
        assert isinstance(code, str)
        assert code == code.upper()


def test_startup_failure_codes_is_subset_of_failure_codes():
    assert protocol.STARTUP_FAILURE_CODES <= protocol.FAILURE_CODES


def test_bridge_unreachable_is_node_side_only_but_still_declared():
    # Documented as Node-side-only in both the build spec and protocol.py's module
    # docstring, but must still be part of the shared code set so both sides validate
    # against the same list.
    assert protocol.BRIDGE_UNREACHABLE in protocol.FAILURE_CODES
    assert protocol.BRIDGE_UNREACHABLE not in protocol.STARTUP_FAILURE_CODES


def test_error_message_accepts_any_failure_code():
    for code in protocol.FAILURE_CODES:
        env = protocol.error_message(code, "some message")
        assert env["code"] == code
        # Must round-trip through the wire cleanly.
        assert protocol.decode(protocol.encode(env)) == env


# --------------------------------------------------------------------------
# Golden fixtures (build spec §4.4 / §5: single source of truth for WP3's TS
# contract test -- Python emits, TypeScript parses, both must agree byte-for-byte
# on structure).
# --------------------------------------------------------------------------


def test_fixture_directory_has_exactly_the_expected_files(load_fixture):
    import pathlib

    fixtures_dir = pathlib.Path(__file__).parent / "fixtures"
    on_disk = {p.stem for p in fixtures_dir.glob("*.json")}
    assert on_disk == EXPECTED_FIXTURE_NAMES


@pytest.mark.parametrize("name", sorted(EXPECTED_FIXTURE_NAMES))
def test_fixture_matches_live_builder_output(name, load_fixture, frozen_now):
    golden = load_fixture(name)
    rebuilt = _build_fixture(name)
    assert rebuilt == golden, (
        f"fixtures/{name}.json is stale relative to protocol.py -- "
        "regenerate it (see this file's module docstring)"
    )


def test_announce_fixture_carries_signal_fields(load_fixture):
    """build spec §5: 'the announce fixture MUST include rssi/snr/q'."""
    announce = load_fixture("announce")
    assert announce["type"] == protocol.TYPE_ANNOUNCE
    for key in ("rssi", "snr", "q"):
        assert key in announce

    assert announce["rssi"] == -97
    assert announce["snr"] == 6.5
    assert announce["q"] == 48


def test_announce_no_signal_fixture_has_null_signal_fields(load_fixture):
    """WP0 §6.3: rssi/snr/q are routinely None over non-RF hops -- the contract test
    on the Node side must treat null, not just a number, as the expected shape."""
    announce = load_fixture("announce_no_signal")
    assert announce["rssi"] is None
    assert announce["snr"] is None
    assert announce["q"] is None
    assert announce["isPathResponse"] is True


def test_interface_stats_fixture_excludes_local_plumbing_types(load_fixture):
    """WP0 correction #2: LocalServerInterface/LocalClientInterface must never appear
    on the wire."""
    stats = load_fixture("interface_stats")
    types = {i["type"] for i in stats["interfaces"]}
    assert types  # sanity: fixture isn't accidentally empty
    assert "LocalServerInterface" not in types
    assert "LocalClientInterface" not in types


def test_error_fixture_uses_a_declared_failure_code(load_fixture):
    error = load_fixture("error")
    assert error["code"] in protocol.FAILURE_CODES


def test_welcome_fixture_declares_protocol_version(load_fixture):
    welcome = load_fixture("welcome")
    assert welcome["protocolVersion"] == protocol.PROTOCOL_VERSION
    assert "bridgeVersion" in welcome
    assert "rnsVersion" in welcome
