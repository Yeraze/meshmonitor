"""Unit tests for meshmonitor_rns_bridge.protocol: envelope encode/decode, failure-code
round trips, and the golden fixtures under tests/fixtures/ that the TS contract test
(WP3) parses independently. The fixture content itself lives in fixture_builders.py
(shared with generate_fixtures.py, the regeneration script) -- if you change a builder
function's output shape, update fixture_builders.py and then run
`python bridge/tests/generate_fixtures.py` to rewrite bridge/tests/fixtures/*.json in
the same commit. The fixtures are the single source of truth for the wire contract;
CI (`.github/workflows/reticulum-bridge.yml`) fails the build if regenerating them
produces a git diff."""

from __future__ import annotations

import json

import pytest

from meshmonitor_rns_bridge import protocol

from .fixture_builders import EXPECTED_FIXTURE_NAMES, FIXED_TS, NON_PROTOCOL_FIXTURE_STEMS
from .fixture_builders import build_fixture as _build_fixture


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
    # NON_PROTOCOL_FIXTURE_STEMS (#3960 Phase 3 WP0/WP2): fixtures that exist
    # under tests/fixtures/*.json but aren't protocol envelopes built via
    # build_fixture() -- e.g. the Sideband FIELD_TELEMETRY golden-decode
    # fixture. Without this union, any such fixture breaks this exact-set
    # assertion despite being intentional and covered by its own tests.
    assert on_disk == EXPECTED_FIXTURE_NAMES | NON_PROTOCOL_FIXTURE_STEMS


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


# --------------------------------------------------------------------------
# Phase 3 (own mode + RNode radio config/device info, build spec §2.B/§2.C,
# #3960 WP1)
# --------------------------------------------------------------------------


def test_protocol_version_is_3():
    """Bumped 2->3 for Phase 3 WP1 (own mode) -- pins the exact value so a
    future accidental revert is caught immediately rather than only via the
    fixture-drift test."""
    assert protocol.PROTOCOL_VERSION == 3


def test_own_mode_and_rnode_failure_codes_are_declared():
    for code in (protocol.OWN_MODE_REQUIRED, protocol.RNODE_DEVICE_UNAVAILABLE, protocol.RNODE_COMMAND_FAILED):
        assert code in protocol.FAILURE_CODES


def test_rnode_device_unavailable_is_a_startup_failure_code():
    assert protocol.RNODE_DEVICE_UNAVAILABLE in protocol.STARTUP_FAILURE_CODES


def test_own_mode_required_and_rnode_command_failed_are_not_startup_codes():
    """Distinguishes command-time failures (radio-config commands, only
    possible after startup already succeeded) from startup failures."""
    assert protocol.OWN_MODE_REQUIRED not in protocol.STARTUP_FAILURE_CODES
    assert protocol.RNODE_COMMAND_FAILED not in protocol.STARTUP_FAILURE_CODES


def test_radio_config_fixture_carries_all_wire_fields(load_fixture):
    radio_config = load_fixture("radio_config")
    for key in (
        "frequency",
        "bandwidth",
        "spreadingFactor",
        "codingRate",
        "txPower",
        "stAlock",
        "ltAlock",
        "radioState",
    ):
        assert key in radio_config


def test_device_info_fixture_carries_all_wire_fields(load_fixture):
    device_info = load_fixture("device_info")
    for key in ("firmwareVersion", "mcu", "platform", "chipTemp", "csma", "phy"):
        assert key in device_info
    for key in ("cwBand", "cwMin", "cwMax"):
        assert key in device_info["csma"]
    for key in (
        "symbolTimeMs",
        "symbolRate",
        "preambleSymbols",
        "preambleTimeMs",
        "csmaSlotTimeMs",
        "csmaDifsMs",
    ):
        assert key in device_info["phy"]


def test_set_radio_config_fixture_is_partial(load_fixture):
    """build spec §2.C 'partial allowed': the fixture only sets two of the
    eight possible radio-config fields."""
    set_radio_config = load_fixture("set_radio_config")
    assert set_radio_config["frequency"] == 915000000
    assert set_radio_config["txPower"] == 20
    assert "bandwidth" not in set_radio_config
    assert "spreadingFactor" not in set_radio_config


def test_configure_message_own_mode_carries_device_and_radio_params():
    env = protocol.configure_message(
        mode="own",
        id="c0",
        device="/dev/ttyUSB0",
        frequency=914875000,
        bandwidth=125000,
        spreading_factor=8,
        coding_rate=5,
        tx_power=17,
        st_alock=33.3,
        lt_alock=None,
    )
    assert env["mode"] == "own"
    assert env["device"] == "/dev/ttyUSB0"
    assert env["frequency"] == 914875000
    assert env["spreadingFactor"] == 8
    assert env["codingRate"] == 5
    assert env["txPower"] == 17
    assert env["stAlock"] == 33.3
    assert "ltAlock" not in env


def test_configure_message_without_own_fields_omits_them():
    env = protocol.configure_message(mode="attach", id="c0", config_dir="/rns")
    assert "device" not in env
    assert "frequency" not in env
