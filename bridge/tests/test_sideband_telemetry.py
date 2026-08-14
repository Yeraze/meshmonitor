"""Unit tests for meshmonitor_rns_bridge.sideband_telemetry (#3960 Phase 3
WP2): decode_field_telemetry() against the WP0 golden fixture pair
(sideband_telemetry_location_battery_temp.bin / .expected.json -- see
docs/internal/dev-notes/RETICULUM_WP0_PHASE3_SPIKE_EVIDENCE.md), plus
targeted unit coverage for the malformed-input paths the fixture doesn't
exercise (decode_field_telemetry() must NEVER raise)."""

from __future__ import annotations

import json
import pathlib
import struct

import msgpack
import pytest

from meshmonitor_rns_bridge.sideband_telemetry import (
    SID_BATTERY,
    SID_HUMIDITY,
    SID_LOCATION,
    SID_NVM,
    SID_PHYSICAL_LINK,
    SID_POWER_CONSUMPTION,
    SID_PRESSURE,
    SID_PROCESSOR,
    SID_RAM,
    SID_TEMPERATURE,
    SID_TIME,
    decode_field_telemetry,
)

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


def _load_bin_fixture(name: str) -> bytes:
    return (FIXTURES_DIR / f"{name}.bin").read_bytes()


def _load_expected_json(name: str) -> dict:
    with open(FIXTURES_DIR / f"{name}.expected.json") as f:
        return json.load(f)


def _pack_location(
    lat: float, lon: float, altitude: float, speed: float, bearing: float, accuracy: float, last_update: int
) -> list:
    """Mirrors Sideband sense.py's Location.pack() (WP0 spike evidence doc
    §4) -- builds the msgpack-`bin`-carrying list a decoder must handle."""
    return [
        struct.pack("!i", int(round(lat, 6) * 1e6)),
        struct.pack("!i", int(round(lon, 6) * 1e6)),
        struct.pack("!i", int(round(altitude, 2) * 1e2)),
        struct.pack("!I", int(round(speed, 2) * 1e2)),
        struct.pack("!i", int(round(bearing, 2) * 1e2)),
        struct.pack("!H", int(round(accuracy, 2) * 1e2)),
        last_update,
    ]


# --------------------------------------------------------------------------
# WP0 golden fixture: real (spec-faithful synthetic) Sideband payload.
# --------------------------------------------------------------------------


def test_decode_matches_wp0_golden_fixture():
    raw = _load_bin_fixture("sideband_telemetry_location_battery_temp")
    expected = _load_expected_json("sideband_telemetry_location_battery_temp")

    decoded = decode_field_telemetry(raw)

    assert decoded["ts"] == expected["ts"]
    assert decoded["location"] == expected["location"]
    assert decoded["sensors"] == expected["sensors"]
    assert decoded["unknownSids"] == expected["unknownSids"]


def test_decode_location_is_byte_exact_not_a_naive_float_read():
    """WP0 §4: Location.pack()'s first six elements are struct.pack'd
    big-endian SCALED bytes carried as msgpack `bin`, not plain floats -- a
    naive float decode would silently produce garbage. Assert the actual
    lat/lon/altitude/speed/bearing/accuracy values, not just "some dict"."""
    raw = _load_bin_fixture("sideband_telemetry_location_battery_temp")
    decoded = decode_field_telemetry(raw)
    assert decoded["location"] == {
        "lat": 37.7749,
        "lon": -122.4194,
        "altitude": 15.5,
        "speed": 1.2,
        "bearing": 270.0,
        "accuracy": 8.5,
    }


def test_decode_unknown_sid_is_dropped_not_crashed():
    """The fixture's SID_AMBIENT_LIGHT (0x0A / 10) entry must never appear
    as a sensors row, and must not raise -- only surface in unknownSids."""
    raw = _load_bin_fixture("sideband_telemetry_location_battery_temp")
    decoded = decode_field_telemetry(raw)
    assert decoded["unknownSids"] == [0x0A]
    assert all(not name.endswith("light") for name in decoded["sensors"])


# --------------------------------------------------------------------------
# Never raises: malformed/truncated input.
# --------------------------------------------------------------------------


def test_decode_garbage_bytes_returns_empty_result_never_raises():
    decoded = decode_field_telemetry(b"\xff\xff\xff not msgpack at all")
    assert decoded == {"ts": None, "location": None, "sensors": {}, "unknownSids": []}


def test_decode_empty_bytes_returns_empty_result_never_raises():
    decoded = decode_field_telemetry(b"")
    assert decoded == {"ts": None, "location": None, "sensors": {}, "unknownSids": []}


def test_decode_non_dict_outer_returns_empty_result():
    raw = msgpack.packb([1, 2, 3])
    decoded = decode_field_telemetry(raw)
    assert decoded == {"ts": None, "location": None, "sensors": {}, "unknownSids": []}


def test_decode_malformed_location_drops_location_but_keeps_sensors():
    """WP0 §6 step 3: a bad SID_LOCATION must drop `location` entirely
    (never half-fill it), but decoding continues for the rest of the
    payload."""
    raw = msgpack.packb({SID_TIME: 1700000000, SID_LOCATION: [1, 2, 3], SID_TEMPERATURE: 21.5})
    decoded = decode_field_telemetry(raw)
    assert decoded["location"] is None
    assert decoded["ts"] == 1700000000
    assert decoded["sensors"]["rns_temperature"] == {"value": 21.5, "unit": "c"}


def test_decode_malformed_battery_sensor_is_skipped_not_fatal():
    """One malformed sensor entry (Battery's pack() should be a
    [charge, charging, temp] list; here it's a bare int) must not drop the
    rest of the message."""
    raw = msgpack.packb({SID_TIME: 1700000000, SID_BATTERY: 42, SID_HUMIDITY: 55.0})
    decoded = decode_field_telemetry(raw)
    assert "rns_battery" not in decoded["sensors"]
    assert decoded["sensors"]["rns_humidity"] == {"value": 55.0, "unit": "%"}


# --------------------------------------------------------------------------
# Per-sensor shape coverage not exercised by the WP0 fixture.
# --------------------------------------------------------------------------


def test_decode_physical_link_fans_out_to_three_rows():
    raw = msgpack.packb({SID_PHYSICAL_LINK: [-80, 7.25, 90]})
    decoded = decode_field_telemetry(raw)
    assert decoded["sensors"] == {
        "rns_link_rssi": {"value": -80.0, "unit": "dbm"},
        "rns_link_snr": {"value": 7.25, "unit": "db"},
        "rns_link_q": {"value": 90.0, "unit": "pct"},
    }


def test_decode_physical_link_partial_nones_only_emits_present_rows():
    raw = msgpack.packb({SID_PHYSICAL_LINK: [-80, None, None]})
    decoded = decode_field_telemetry(raw)
    assert decoded["sensors"] == {"rns_link_rssi": {"value": -80.0, "unit": "dbm"}}


@pytest.mark.parametrize(
    ("sid", "type_name"),
    [
        (SID_POWER_CONSUMPTION, "rns_power_in"),
        (SID_PROCESSOR, "rns_cpu"),
        (SID_RAM, "rns_ram"),
        (SID_NVM, "rns_nvm"),
    ],
)
def test_decode_list_shape_sensors_reduce_to_default_labeled_entry(sid, type_name):
    """Power*/Processor/RAM/NVM share list[[type_label, [...]], ...] -- the
    0x00-labeled ("default") entry's first inner value is what gets
    surfaced; a non-0x00 entry is ignored."""
    raw = msgpack.packb({sid: [[0x01, [999.0]], [0x00, [12.5, "extra"]]]})
    decoded = decode_field_telemetry(raw)
    assert decoded["sensors"][type_name]["value"] == 12.5


def test_decode_pressure_scalar_sensor():
    raw = msgpack.packb({SID_PRESSURE: 1013.25})
    decoded = decode_field_telemetry(raw)
    assert decoded["sensors"]["rns_pressure"] == {"value": 1013.25, "unit": "mbar"}


def test_decode_no_sid_time_leaves_ts_none():
    raw = msgpack.packb({SID_TEMPERATURE: 20.0})
    decoded = decode_field_telemetry(raw)
    assert decoded["ts"] is None
    assert decoded["sensors"]["rns_temperature"] == {"value": 20.0, "unit": "c"}


def test_decode_location_round_trip_via_local_pack_helper():
    """Sanity check that this test module's own _pack_location() helper --
    used by other tests that don't want to depend on the checked-in .bin
    fixture -- agrees with the module under test."""
    loc = _pack_location(
        lat=51.5074, lon=-0.1278, altitude=35.0, speed=0.0, bearing=0.0, accuracy=5.0, last_update=1700000000
    )
    raw = msgpack.packb({SID_TIME: 1700000000, SID_LOCATION: loc})
    decoded = decode_field_telemetry(raw)
    assert decoded["location"] == {
        "lat": 51.5074,
        "lon": -0.1278,
        "altitude": 35.0,
        "speed": 0.0,
        "bearing": 0.0,
        "accuracy": 5.0,
    }
