"""Unit tests for the pure-function helpers rns_manager.py adds for Phase 2
(LXMF messaging, #3960 WP1): the numeric-state/method wire mappings and the
field sanitizer (R3: attachment metadata only, never raw bytes). These are
exercised directly here rather than only through the dual-rnsd integration
test, since several branches (REJECTED/CANCELLED/an unknown future state,
long-bytes truncation) aren't things the happy-path send/receive integration
test naturally hits.

Deliberately does NOT touch RNS.Reticulum()/LXMRouter networking here (WP0
correction #3: a second `RNS.Reticulum()` construction in the same process
raises -- see integration/test_dual_rnsd.py's module docstring). The one
exception, `_load_or_create_lxmf_identity`, only touches `RNS.Identity`
(key generation + file I/O), which has no such singleton constraint.
"""

from __future__ import annotations

import queue
from typing import Optional
from unittest.mock import MagicMock, patch

import LXMF
import msgpack
import RNS
import pytest

from meshmonitor_rns_bridge import protocol
from meshmonitor_rns_bridge.config import BridgeConfig
from meshmonitor_rns_bridge.rns_manager import (
    OwnModeRequiredError,
    RNSManager,
    RNSStartupError,
    _build_rnode_ifconf,
    _jsonify_field_value,
    _load_or_create_lxmf_identity,
    _lxmf_method_to_wire,
    _lxmf_state_to_wire,
    _sanitize_lxmf_fields,
)

# --------------------------------------------------------------------------
# Delivery-state mapping
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("state", "expected"),
    [
        (LXMF.LXMessage.GENERATING, "sending"),
        (LXMF.LXMessage.OUTBOUND, "sending"),
        (LXMF.LXMessage.SENDING, "sending"),
        (LXMF.LXMessage.SENT, "sent"),
        (LXMF.LXMessage.DELIVERED, "delivered"),
        (LXMF.LXMessage.REJECTED, "failed"),
        (LXMF.LXMessage.CANCELLED, "failed"),
        (LXMF.LXMessage.FAILED, "failed"),
    ],
)
def test_lxmf_state_to_wire_maps_every_known_state(state, expected):
    assert _lxmf_state_to_wire(state) == expected


def test_lxmf_state_to_wire_unknown_state_fails_closed():
    """A hypothetical future LXMF state constant not in the mapping table
    must map to "failed" rather than raising or silently disappearing."""
    assert _lxmf_state_to_wire(0x77) == "failed"


# --------------------------------------------------------------------------
# Method mapping
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "expected"),
    [
        (LXMF.LXMessage.OPPORTUNISTIC, "opportunistic"),
        (LXMF.LXMessage.DIRECT, "direct"),
        (LXMF.LXMessage.PROPAGATED, "propagated"),
        (LXMF.LXMessage.PAPER, "paper"),
    ],
)
def test_lxmf_method_to_wire_maps_every_known_method(method, expected):
    assert _lxmf_method_to_wire(method) == expected


def test_lxmf_method_to_wire_unknown_is_null():
    """UNKNOWN (0, e.g. read immediately after handle_outbound() before the
    router's background thread has picked a method) must be nullable on the
    wire, not an arbitrary string."""
    assert _lxmf_method_to_wire(LXMF.LXMessage.UNKNOWN) is None


# --------------------------------------------------------------------------
# Field sanitation (R3: attachment metadata only, never raw bytes)
# --------------------------------------------------------------------------


def test_sanitize_lxmf_fields_empty_or_none_returns_empty_dict():
    assert _sanitize_lxmf_fields(None) == {}
    assert _sanitize_lxmf_fields({}) == {}


def test_sanitize_lxmf_fields_known_field_ids_get_named():
    fields = {
        LXMF.FIELD_THREAD: b"\x9f\x8e\x7d\x6c",
        LXMF.FIELD_RENDERER: LXMF.RENDERER_MARKDOWN,
    }
    out = _sanitize_lxmf_fields(fields)
    assert out["thread"] == "9f8e7d6c"
    assert out["renderer"] == LXMF.RENDERER_MARKDOWN


def test_sanitize_lxmf_fields_unknown_field_id_falls_back_to_numeric_string():
    out = _sanitize_lxmf_fields({0x99: "custom"})
    assert out["153"] == "custom"


def test_sanitize_lxmf_fields_short_bytes_are_hex_encoded_not_dropped():
    out = _sanitize_lxmf_fields({LXMF.FIELD_REPLY_TO: b"\x01\x02\x03"})
    assert out["replyTo"] == "010203"


def test_sanitize_lxmf_fields_long_bytes_never_reach_the_wire():
    """R3: attachment/binary payload content must never be inlined -- only a
    length placeholder."""
    payload = b"x" * 5000
    out = _sanitize_lxmf_fields({LXMF.FIELD_FILE_ATTACHMENTS: payload})
    assert out["fileAttachments"] == {"bytesLength": 5000}
    assert "x" * 100 not in str(out)


def test_jsonify_field_value_handles_nested_structures():
    value = {"name": b"photo.png", "size": 1234, "nested": [1, b"\x00" * 100, "ok"]}
    out = _jsonify_field_value(value)
    assert out["name"] == RNS.hexrep(b"photo.png", delimit=False)
    assert out["size"] == 1234
    assert out["nested"][0] == 1
    assert out["nested"][1] == {"bytesLength": 100}
    assert out["nested"][2] == "ok"


def test_jsonify_field_value_passes_through_json_native_types():
    assert _jsonify_field_value("plain") == "plain"
    assert _jsonify_field_value(42) == 42
    assert _jsonify_field_value(3.14) == 3.14
    assert _jsonify_field_value(True) is True
    assert _jsonify_field_value(None) is None


# --------------------------------------------------------------------------
# Identity load-or-create (build spec §3.4 / R5)
# --------------------------------------------------------------------------


def test_load_or_create_lxmf_identity_creates_directory_and_persists(tmp_path):
    storage_dir = tmp_path / "lxmf-storage"
    assert not storage_dir.exists()

    identity = _load_or_create_lxmf_identity(str(storage_dir))

    assert storage_dir.is_dir()
    assert (storage_dir / "identity").is_file()
    assert isinstance(identity, RNS.Identity)


def test_load_or_create_lxmf_identity_is_stable_across_calls(tmp_path):
    """R5: the same source must get the same LXMF address back after a
    restart -- a fresh identity every call would silently rotate the
    destination hash out from under any peer who'd announced/pathed to it."""
    storage_dir = tmp_path / "lxmf-storage"

    first = _load_or_create_lxmf_identity(str(storage_dir))
    second = _load_or_create_lxmf_identity(str(storage_dir))

    assert first.hash == second.hash
    assert first.get_public_key() == second.get_public_key()


def test_load_or_create_lxmf_identity_directory_is_owner_only(tmp_path):
    storage_dir = tmp_path / "lxmf-storage"
    _load_or_create_lxmf_identity(str(storage_dir))

    mode = storage_dir.stat().st_mode & 0o777
    assert mode == 0o700


# --------------------------------------------------------------------------
# own mode (Phase 3, #3960 WP1, build spec §2.B): _build_rnode_ifconf() is a
# pure function -- no RNS import involved -- tested directly with no
# mocking needed.
# --------------------------------------------------------------------------


def test_build_rnode_ifconf_device_only():
    conf = _build_rnode_ifconf("/dev/ttyUSB0", {})
    assert conf == {"name": "own_rnode", "port": "/dev/ttyUSB0"}


def test_build_rnode_ifconf_with_all_params_are_strings():
    conf = _build_rnode_ifconf(
        "/dev/ttyUSB0",
        {
            "frequency": 914875000,
            "bandwidth": 125000,
            "sf": 8,
            "cr": 5,
            "txpower": 17,
            "st_alock": 33.3,
            "lt_alock": 66.6,
        },
    )
    assert conf == {
        "name": "own_rnode",
        "port": "/dev/ttyUSB0",
        "frequency": "914875000",
        "bandwidth": "125000",
        "spreadingfactor": "8",
        "codingrate": "5",
        "txpower": "17",
        "airtime_limit_short": "33.3",
        "airtime_limit_long": "66.6",
    }


def test_build_rnode_ifconf_omits_unset_params():
    conf = _build_rnode_ifconf("/dev/ttyUSB0", {"frequency": 914875000})
    assert "bandwidth" not in conf
    assert "airtime_limit_short" not in conf


# --------------------------------------------------------------------------
# own mode: RNSManager._start_own() -- anti-grind guard (#3960 Phase 3 R1):
# NO physical RNode, NO live serial open, ever. RNS.Reticulum and
# RNS.Interfaces.RNodeInterface.RNodeInterface are always mocked here, so
# these tests touch neither hardware nor a real process-wide RNS.Reticulum
# singleton (see this module's docstring for why real RNS.Reticulum() calls
# are avoided in unit tests).
# --------------------------------------------------------------------------


def _own_manager() -> RNSManager:
    cfg = BridgeConfig(token="s3cret", mode="own", own_device="/dev/ttyUSB0")
    return RNSManager(cfg)


def test_start_own_missing_device_raises_without_touching_rns():
    manager = _own_manager()
    with patch("RNS.Reticulum") as mock_reticulum:
        with pytest.raises(RNSStartupError) as excinfo:
            manager._start_own(None, None, {})
    assert excinfo.value.code == "RNODE_DEVICE_UNAVAILABLE"
    mock_reticulum.assert_not_called()


def test_start_own_nonexistent_device_path_raises_without_touching_rns(tmp_path):
    manager = _own_manager()
    missing = str(tmp_path / "does-not-exist")
    with patch("RNS.Reticulum") as mock_reticulum:
        with pytest.raises(RNSStartupError) as excinfo:
            manager._start_own(None, missing, {})
    assert excinfo.value.code == "RNODE_DEVICE_UNAVAILABLE"
    mock_reticulum.assert_not_called()


def test_start_own_interface_never_comes_online_raises(tmp_path):
    device = tmp_path / "ttyUSB0"
    device.write_bytes(b"")
    manager = _own_manager()

    mock_reticulum_instance = MagicMock()
    mock_interface = MagicMock(online=False)
    with patch("RNS.Reticulum", return_value=mock_reticulum_instance):
        with patch("RNS.Interfaces.RNodeInterface.RNodeInterface", return_value=mock_interface):
            with pytest.raises(RNSStartupError) as excinfo:
                manager._start_own(None, str(device), {})

    assert excinfo.value.code == "RNODE_DEVICE_UNAVAILABLE"
    mock_reticulum_instance._add_interface.assert_called_once_with(mock_interface)
    assert manager._rnode_interface is None


def test_start_own_happy_path_sets_reticulum_and_interface(tmp_path):
    device = tmp_path / "ttyUSB0"
    device.write_bytes(b"")
    manager = _own_manager()

    mock_reticulum_instance = MagicMock()
    mock_interface = MagicMock(online=True)
    with patch("RNS.Reticulum", return_value=mock_reticulum_instance) as mock_reticulum_cls:
        with patch(
            "RNS.Interfaces.RNodeInterface.RNodeInterface", return_value=mock_interface
        ) as mock_interface_cls:
            manager._start_own("/rns", str(device), {"frequency": 914875000})

    mock_reticulum_cls.assert_called_once_with(configdir="/rns")
    mock_interface_cls.assert_called_once()
    mock_reticulum_instance._add_interface.assert_called_once_with(mock_interface)
    assert manager.reticulum is mock_reticulum_instance
    assert manager._rnode_interface is mock_interface


def test_start_own_reticulum_construction_failure_is_rns_init_failed(tmp_path):
    device = tmp_path / "ttyUSB0"
    device.write_bytes(b"")
    manager = _own_manager()

    with patch("RNS.Reticulum", side_effect=RuntimeError("boom")):
        with pytest.raises(RNSStartupError) as excinfo:
            manager._start_own(None, str(device), {})
    assert excinfo.value.code == "RNS_INIT_FAILED"


# --------------------------------------------------------------------------
# own mode: get_radio_config() / set_radio_config() / get_device_info() --
# always exercised against a MagicMock/attribute stand-in for
# RNodeInterface, never a real one.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("method_name", ["get_radio_config", "get_device_info"])
def test_radio_methods_require_own_mode(method_name):
    cfg = BridgeConfig(token="s3cret", mode="attach")
    manager = RNSManager(cfg)
    with pytest.raises(OwnModeRequiredError):
        getattr(manager, method_name)()


def test_set_radio_config_requires_own_mode():
    cfg = BridgeConfig(token="s3cret", mode="attach")
    manager = RNSManager(cfg)
    with pytest.raises(OwnModeRequiredError):
        manager.set_radio_config({"frequency": 915000000})


def test_radio_methods_require_a_live_interface_even_in_own_mode():
    """own mode selected but start() hasn't run yet (or _start_own() never
    completed) -- _rnode_interface is still None."""
    manager = _own_manager()
    assert manager._effective_mode == "own"
    with pytest.raises(OwnModeRequiredError):
        manager.get_radio_config()


def _mock_rnode_interface(**overrides) -> MagicMock:
    defaults = dict(
        frequency=914875000,
        bandwidth=125000,
        sf=8,
        cr=5,
        txpower=17,
        st_alock=33.3,
        lt_alock=None,
        state=1,
        maj_version=1,
        min_version=52,
        mcu=0x1E,
        platform=0x80,
        cpu_temp=34,
        r_csma_cw_band=2,
        r_csma_cw_min=3,
        r_csma_cw_max=8,
        r_symbol_time_ms=32.768,
        r_symbol_rate=976,
        r_preamble_symbols=12,
        r_premable_time_ms=393,
        r_csma_slot_time_ms=15,
        r_csma_difs_ms=45,
    )
    defaults.update(overrides)
    return MagicMock(**defaults)


def test_get_radio_config_reads_interface_attributes():
    manager = _own_manager()
    manager._rnode_interface = _mock_rnode_interface()

    config = manager.get_radio_config()

    assert config == {
        "frequency": 914875000,
        "bandwidth": 125000,
        "spreadingFactor": 8,
        "codingRate": 5,
        "txPower": 17,
        "stAlock": 33.3,
        "ltAlock": None,
        "radioState": True,
    }


def test_get_radio_config_radio_state_off_is_false():
    manager = _own_manager()
    manager._rnode_interface = _mock_rnode_interface(state=0)
    assert manager.get_radio_config()["radioState"] is False


def test_set_radio_config_applies_partial_params_and_calls_setters():
    manager = _own_manager()
    interface = _mock_rnode_interface()
    manager._rnode_interface = interface

    manager.set_radio_config({"frequency": 915000000, "txPower": 20})

    assert interface.frequency == 915000000
    assert interface.txpower == 20
    interface.setFrequency.assert_called_once_with()
    interface.setTXPower.assert_called_once_with()
    # Untouched fields must not have their setters called.
    interface.setBandwidth.assert_not_called()
    interface.setSpreadingFactor.assert_not_called()


def test_set_radio_config_returns_post_write_config():
    manager = _own_manager()
    interface = _mock_rnode_interface()
    manager._rnode_interface = interface

    result = manager.set_radio_config({"frequency": 915000000})

    assert result["frequency"] == 915000000


def test_set_radio_config_radio_state_true_calls_set_radio_state_on():
    manager = _own_manager()
    interface = _mock_rnode_interface()
    manager._rnode_interface = interface

    manager.set_radio_config({"radioState": True})

    interface.setRadioState.assert_called_once_with(1)  # RADIO_STATE_ON


def test_set_radio_config_radio_state_false_calls_set_radio_state_off():
    manager = _own_manager()
    interface = _mock_rnode_interface()
    manager._rnode_interface = interface

    manager.set_radio_config({"radioState": False})

    interface.setRadioState.assert_called_once_with(0)  # RADIO_STATE_OFF


def test_set_radio_config_ignores_none_values():
    manager = _own_manager()
    interface = _mock_rnode_interface()
    manager._rnode_interface = interface

    manager.set_radio_config({"frequency": None})

    interface.setFrequency.assert_not_called()


def test_get_device_info_reads_interface_attributes():
    manager = _own_manager()
    manager._rnode_interface = _mock_rnode_interface()

    info = manager.get_device_info()

    assert info == {
        "firmwareVersion": "1.52",
        "mcu": 0x1E,
        "platform": 0x80,
        "chipTemp": 34,
        "csma": {"cwBand": 2, "cwMin": 3, "cwMax": 8},
        "phy": {
            "symbolTimeMs": 32.768,
            "symbolRate": 976,
            "preambleSymbols": 12,
            "preambleTimeMs": 393,
            "csmaSlotTimeMs": 15,
            "csmaDifsMs": 45,
        },
    }


def test_get_device_info_missing_fw_version_is_none():
    manager = _own_manager()
    manager._rnode_interface = _mock_rnode_interface(maj_version=None, min_version=None)
    assert manager.get_device_info()["firmwareVersion"] is None


# --------------------------------------------------------------------------
# Sideband FIELD_TELEMETRY interception (#3960 Phase 3 WP2, build spec
# §2.A): `_on_lxmf_delivery` must detect `LXMF.FIELD_TELEMETRY` off the raw
# `get_fields()` dict BEFORE `_sanitize_lxmf_fields()` hex-collapses it,
# emit a `telemetry` event, and skip the `lxmf_message` event entirely for
# a telemetry-only delivery (no title/content) -- R3: no chat row for a
# packet that carries no text. A delivery with both text and telemetry
# emits both events. Deliberately does NOT touch RNS.Reticulum()/LXMRouter
# networking (same constraint as the rest of this file) -- `message` is a
# MagicMock stand-in for a real `LXMF.LXMessage`, and `broadcast()`/
# `subscribe()` are pure in-process pub/sub with no RNS involvement.
# --------------------------------------------------------------------------


def _fake_lxm_message(
    *,
    fields: dict,
    title: Optional[bytes] = None,
    content: Optional[bytes] = None,
    title_str: Optional[str] = None,
    content_str: Optional[str] = None,
) -> MagicMock:
    message = MagicMock()
    message.hash = b"\x1a\x2b\x3c\x4d"
    message.source_hash = b"\xa1\xb2\xc3\xd4"
    message.destination_hash = b"\x11\x22\x33\x44"
    # `_on_lxmf_delivery` gates on truthiness of `message.title`/`.content`
    # before calling `title_as_string()`/`content_as_string()` -- matches
    # the real LXMessage contract (bytes-or-None).
    message.title = title
    message.content = content
    message.title_as_string.return_value = title_str
    message.content_as_string.return_value = content_str
    message.get_fields.return_value = fields
    message.method = LXMF.LXMessage.OPPORTUNISTIC
    message.signature_validated = True
    message.ratchet_id = None
    message.rssi = None
    message.snr = None
    message.q = None
    return message


def _drain(q: "queue.Queue") -> list:
    events = []
    while True:
        try:
            events.append(q.get_nowait())
        except queue.Empty:
            break
    return events


def _manager() -> RNSManager:
    return RNSManager(BridgeConfig(token="s3cret"))


def test_on_lxmf_delivery_telemetry_only_emits_telemetry_not_message():
    manager = _manager()
    q = manager.subscribe()
    telemetry_raw = msgpack.packb({0x07: 21.5})  # SID_TEMPERATURE
    message = _fake_lxm_message(fields={LXMF.FIELD_TELEMETRY: telemetry_raw}, title=None, content=None)

    manager._on_lxmf_delivery(message)

    events = _drain(q)
    assert len(events) == 1
    assert events[0]["type"] == protocol.TYPE_TELEMETRY
    assert events[0]["sensors"]["rns_temperature"] == {"value": 21.5, "unit": "c"}


def test_on_lxmf_delivery_text_and_telemetry_emits_both():
    manager = _manager()
    q = manager.subscribe()
    telemetry_raw = msgpack.packb({0x07: 21.5})
    message = _fake_lxm_message(
        fields={LXMF.FIELD_TELEMETRY: telemetry_raw},
        title=b"Hello",
        content=b"World",
        title_str="Hello",
        content_str="World",
    )

    manager._on_lxmf_delivery(message)

    events = _drain(q)
    types = {e["type"] for e in events}
    assert types == {protocol.TYPE_TELEMETRY, protocol.TYPE_LXMF_MESSAGE}
    lxmf_event = next(e for e in events if e["type"] == protocol.TYPE_LXMF_MESSAGE)
    assert lxmf_event["title"] == "Hello"
    assert lxmf_event["content"] == "World"


def test_on_lxmf_delivery_text_only_never_emits_telemetry():
    manager = _manager()
    q = manager.subscribe()
    message = _fake_lxm_message(fields={}, title=b"Hello", content=b"World", title_str="Hello", content_str="World")

    manager._on_lxmf_delivery(message)

    events = _drain(q)
    assert len(events) == 1
    assert events[0]["type"] == protocol.TYPE_LXMF_MESSAGE


def test_on_lxmf_delivery_telemetry_event_carries_source_and_destination_hash():
    manager = _manager()
    q = manager.subscribe()
    telemetry_raw = msgpack.packb({0x07: 21.5})
    message = _fake_lxm_message(fields={LXMF.FIELD_TELEMETRY: telemetry_raw}, title=None, content=None)

    manager._on_lxmf_delivery(message)

    event = _drain(q)[0]
    assert event["sourceHash"] == RNS.hexrep(message.source_hash, delimit=False)
    assert event["destinationHash"] == RNS.hexrep(message.destination_hash, delimit=False)


def test_on_lxmf_delivery_malformed_telemetry_bytes_still_treated_as_telemetry_only():
    """Garbage FIELD_TELEMETRY bytes decode to an empty result (never
    raises) but the field's mere PRESENCE with no text still counts as
    telemetry-only -- no lxmf_message event, even though the telemetry
    event itself carries empty sensors/location/ts."""
    manager = _manager()
    q = manager.subscribe()
    message = _fake_lxm_message(fields={LXMF.FIELD_TELEMETRY: b"\xff\xff not msgpack"}, title=None, content=None)

    manager._on_lxmf_delivery(message)

    events = _drain(q)
    assert len(events) == 1
    assert events[0]["type"] == protocol.TYPE_TELEMETRY
    assert events[0]["sensors"] == {}
    assert events[0]["location"] is None


def test_on_lxmf_delivery_non_bytes_telemetry_field_is_skipped_safely():
    """A non-bytes FIELD_TELEMETRY value (shouldn't happen from a real lxmf
    delivery, but defends against a hostile/buggy peer) must not crash the
    delivery callback."""
    manager = _manager()
    q = manager.subscribe()
    message = _fake_lxm_message(fields={LXMF.FIELD_TELEMETRY: "not-bytes"}, title=None, content=None)

    manager._on_lxmf_delivery(message)

    # telemetry_raw is not None, so still counted telemetry-only (no
    # lxmf_message event); _emit_telemetry_event itself declines to decode
    # and broadcasts nothing -- a defensive no-op, never a crash.
    assert _drain(q) == []


def test_on_lxmf_delivery_no_telemetry_field_behaves_as_before():
    """Regression: a delivery with no FIELD_TELEMETRY key at all must be
    unaffected by the WP2 interception -- exactly one lxmf_message event,
    same as pre-WP2 behavior."""
    manager = _manager()
    q = manager.subscribe()
    message = _fake_lxm_message(
        fields={LXMF.FIELD_THREAD: b"\x01\x02"}, title=b"Hi", content=b"there", title_str="Hi", content_str="there"
    )

    manager._on_lxmf_delivery(message)

    events = _drain(q)
    assert len(events) == 1
    assert events[0]["type"] == protocol.TYPE_LXMF_MESSAGE
    assert events[0]["fields"]["thread"] == "0102"
