"""Sideband FIELD_TELEMETRY decode (#3960 Phase 3 WP2).

Decodes `LXMF.FIELD_TELEMETRY` (LXMF field id 0x02): Sideband's sense.py
`Telemeter.packed()` msgpack-encodes the sensor set as a single flat
`{sid: per_sensor_value}` dict, carried as the *value* under that field key
(one msgpack layer, not two -- see the WP0 spike evidence doc §1).

See docs/internal/dev-notes/RETICULUM_WP0_PHASE3_SPIKE_EVIDENCE.md for the
full decode contract this module implements verbatim:

  - SID_TIME (0x01) is unconditionally present in every real Sideband
    payload and feeds the top-level `ts`, never a `sensors` row.
  - SID_LOCATION (0x02)'s `pack()` list has its first SIX elements as
    fixed-width BIG-ENDIAN `struct.pack` byte strings (msgpack `bin`, NOT
    plain msgpack numbers), individually scaled before packing (lat/lon
    x1e6, altitude/speed/bearing/accuracy x1e2). A decoder that assumes
    floats gets garbage; `_decode_location()` below is `Location.unpack()`
    ported byte-for-byte.
  - The pinned SID subset (build spec §2.A) maps to stable `rns_*`
    telemetryType names; SID_PHYSICAL_LINK fans out to three rows
    (rns_link_rssi/rns_link_snr/rns_link_q); the `list[[type_label,
    [...]], ...]` shape shared by Power*/Processor/RAM/NVM reduces to the
    0x00-labeled ("the" single/default) entry's first inner value.
  - Any other SID is unknown -- opaque, skipped, never raises.

`decode_field_telemetry()` never raises: a malformed/truncated `raw` (bad
outer msgpack, or a pinned SID whose inner shape doesn't match
expectations) is logged and yields the partial/empty result, since
Reticulum peers are untrusted by construction.
"""

from __future__ import annotations

import logging
import struct
from typing import Any, Optional

import msgpack

logger = logging.getLogger("meshmonitor_rns_bridge.sideband_telemetry")

# --------------------------------------------------------------------------
# Sensor IDs (Sideband sbapp/sideband/sense.py `class Sensor`, confirmed
# against master 2026-08-14 per the WP0 spike evidence doc §2).
# --------------------------------------------------------------------------

SID_NONE = 0x00
SID_TIME = 0x01
SID_LOCATION = 0x02
SID_PRESSURE = 0x03
SID_BATTERY = 0x04
SID_PHYSICAL_LINK = 0x05
SID_TEMPERATURE = 0x07
SID_HUMIDITY = 0x08
SID_POWER_CONSUMPTION = 0x11
SID_POWER_PRODUCTION = 0x12
SID_PROCESSOR = 0x13
SID_RAM = 0x14
SID_NVM = 0x15

# Pinned SID -> stable wire telemetryType name (build spec §2.A). SID_TIME
# and SID_LOCATION are handled specially (top-level `ts` / `location`), so
# they are deliberately NOT entries here; SID_PHYSICAL_LINK fans out to
# three rows and is also handled specially rather than through this map.
SID_TO_TYPE: dict = {
    SID_BATTERY: "rns_battery",
    SID_TEMPERATURE: "rns_temperature",
    SID_HUMIDITY: "rns_humidity",
    SID_PRESSURE: "rns_pressure",
    SID_POWER_CONSUMPTION: "rns_power_in",
    SID_POWER_PRODUCTION: "rns_power_out",
    SID_PROCESSOR: "rns_cpu",
    SID_RAM: "rns_ram",
    SID_NVM: "rns_nvm",
}

# telemetryType -> fixed unit. Matches the WP0 spike evidence doc §3's
# per-sensor unit callouts.
_UNITS: dict = {
    "rns_battery": "%",
    "rns_temperature": "c",
    "rns_humidity": "%",
    "rns_pressure": "mbar",
    "rns_power_in": "w",
    "rns_power_out": "w",
    "rns_cpu": "pct",
    "rns_ram": "pct",
    "rns_nvm": "pct",
    "rns_link_rssi": "dbm",
    "rns_link_snr": "db",
    "rns_link_q": "pct",
}

# Sensors whose pack() is `list[[type_label, [...]], ...]` (WP0 §3):
# reduced to the 0x00-labeled ("the" single/default) entry's first inner
# value for Phase 3's flat telemetry-row model.
_LIST_SHAPE_SIDS = frozenset({SID_POWER_CONSUMPTION, SID_POWER_PRODUCTION, SID_PROCESSOR, SID_RAM, SID_NVM})


def _empty_result() -> dict:
    return {"ts": None, "location": None, "sensors": {}, "unknownSids": []}


def _decode_location(raw: Any) -> Optional[dict]:
    """Port of Sideband sense.py's `Location.unpack()`, verbatim (WP0 spike
    evidence doc §4): the first six list elements are big-endian
    `struct.pack` byte strings (msgpack `bin`), individually scaled --
    NOT plain msgpack numbers. Element 6 (`last_update`, a plain int
    timestamp) is intentionally not consumed here; the top-level `ts` from
    SID_TIME already carries that (see `decode_field_telemetry()`).

    Returns None (never partially filled) if anything about the shape is
    off -- caller drops `location` entirely for this message and continues
    decoding sensors, per the spike evidence doc's "don't half-fill it"
    guidance.
    """
    try:
        lat = struct.unpack("!i", raw[0])[0] / 1e6
        lon = struct.unpack("!i", raw[1])[0] / 1e6
        altitude = struct.unpack("!i", raw[2])[0] / 1e2
        speed = struct.unpack("!I", raw[3])[0] / 1e2
        bearing = struct.unpack("!i", raw[4])[0] / 1e2
        accuracy = struct.unpack("!H", raw[5])[0] / 1e2
    except Exception:
        logger.warning("failed to decode SID_LOCATION", exc_info=True)
        return None
    return {
        "lat": lat,
        "lon": lon,
        "altitude": altitude,
        "speed": speed,
        "bearing": bearing,
        "accuracy": accuracy,
    }


def _first_default_inner_value(entries: Any) -> Optional[float]:
    """Power*/Processor/RAM/NVM share `list[[type_label, [...]], ...]`
    (WP0 spike evidence doc §3, multiple named consumers/producers per
    device) -- reduce to the 0x00-labeled ("the" single/default) entry's
    first inner value. Returns None if no 0x00-labeled entry exists or its
    shape doesn't match, rather than guessing."""
    if not isinstance(entries, (list, tuple)):
        return None
    for entry in entries:
        try:
            label, inner = entry
        except (TypeError, ValueError):
            continue
        if label == SID_NONE and isinstance(inner, (list, tuple)) and inner:
            value = inner[0]
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return float(value)
    return None


def _decode_physical_link(value: Any, sensors: dict) -> None:
    """SID_PHYSICAL_LINK's `pack()` -> `[rssi, snr, q]` (list, positional,
    any may be None) -- fans out to three telemetry rows rather than one,
    each row emitted only if its value is present."""
    try:
        rssi, snr, q = value[0], value[1], value[2]
    except (TypeError, IndexError, KeyError):
        logger.warning("failed to decode SID_PHYSICAL_LINK", exc_info=True)
        return
    if isinstance(rssi, (int, float)) and not isinstance(rssi, bool):
        sensors["rns_link_rssi"] = {"value": float(rssi), "unit": _UNITS["rns_link_rssi"]}
    if isinstance(snr, (int, float)) and not isinstance(snr, bool):
        sensors["rns_link_snr"] = {"value": float(snr), "unit": _UNITS["rns_link_snr"]}
    if isinstance(q, (int, float)) and not isinstance(q, bool):
        sensors["rns_link_q"] = {"value": float(q), "unit": _UNITS["rns_link_q"]}


def _decode_sensor(sid: int, value: Any, sensors: dict) -> None:
    """Decode one pinned-SID entry into `sensors` (mutated in place). Any
    per-sensor IndexError/TypeError/KeyError is swallowed here -- one
    malformed sensor entry must never drop the whole message (WP0 spike
    evidence doc §6 step 4)."""
    type_name = SID_TO_TYPE[sid]
    try:
        if sid == SID_BATTERY:
            # Battery.pack() -> [charge_percent, charging, temperature|None].
            charge = value[0]
            if isinstance(charge, (int, float)) and not isinstance(charge, bool):
                sensors[type_name] = {"value": float(charge), "unit": _UNITS[type_name]}
        elif sid in _LIST_SHAPE_SIDS:
            inner_value = _first_default_inner_value(value)
            if inner_value is not None:
                sensors[type_name] = {"value": inner_value, "unit": _UNITS[type_name]}
        else:
            # Scalar sensors: Temperature/Humidity/Pressure -- bare float.
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                sensors[type_name] = {"value": float(value), "unit": _UNITS[type_name]}
    except (IndexError, TypeError, KeyError):
        logger.warning("failed to decode sensor sid=0x%02x", sid, exc_info=True)


def decode_field_telemetry(raw: bytes) -> dict:
    """Decode `lxm.fields[LXMF.FIELD_TELEMETRY]` -- `raw` is the bytes value
    already extracted by the `lxmf` package's own field-dict unpacking, NOT
    the whole LXMF message, just this one field's value.

    Returns:
        {
          "ts": int | None,                     # from SID_TIME, if present
          "location": {                          # only if SID_LOCATION present and decodable
            "lat": float, "lon": float, "altitude": float,
            "speed": float, "bearing": float, "accuracy": float,
          } | None,
          "sensors": {                           # pinned subset only
            "<telemetryType>": {"value": float, "unit": str},
            ...
          },
          "unknownSids": [int, ...],             # sorted, unpinned SIDs seen (never raises)
        }

    Never raises. A malformed/truncated `raw` (bad outer msgpack, or a
    pinned SID whose inner shape doesn't match expectations) is logged and
    yields the partial/empty result -- it must never crash the LXMF
    delivery callback, since Reticulum peers are untrusted by construction.
    """
    result = _empty_result()

    try:
        outer = msgpack.unpackb(raw, raw=False, strict_map_key=False)
    except Exception:
        logger.warning("failed to msgpack-decode FIELD_TELEMETRY", exc_info=True)
        return result

    if not isinstance(outer, dict):
        logger.warning("FIELD_TELEMETRY decoded to a non-dict (%s)", type(outer).__name__)
        return result

    ts_value = outer.get(SID_TIME)
    if isinstance(ts_value, (int, float)) and not isinstance(ts_value, bool):
        result["ts"] = int(ts_value)

    if SID_LOCATION in outer:
        loc_raw = outer[SID_LOCATION]
        if isinstance(loc_raw, (list, tuple)) and len(loc_raw) >= 6:
            result["location"] = _decode_location(loc_raw)
        else:
            logger.warning("SID_LOCATION present but not a 6+-element list")

    sensors: dict = {}
    unknown_sids: list = []
    for sid, value in outer.items():
        if not isinstance(sid, int) or sid in (SID_TIME, SID_LOCATION):
            continue
        if sid == SID_PHYSICAL_LINK:
            _decode_physical_link(value, sensors)
            continue
        if sid not in SID_TO_TYPE:
            unknown_sids.append(sid)
            continue
        _decode_sensor(sid, value, sensors)

    result["sensors"] = sensors
    result["unknownSids"] = sorted(unknown_sids)
    return result
