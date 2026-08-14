# Reticulum Phase 3 WP0, Sideband FIELD_TELEMETRY Decode Spike Evidence (#3960)

**Date:** 2026-08-14 · **Gate for:** WP2 (bridge Sideband telemetry decode).
**Timebox:** fixture-build + format-confirmation only, no `rnsd` networking (R5).

## Result: GATE PASSES

`LXMF.FIELD_TELEMETRY` (0x02) is confirmed msgpack, its inner layout is confirmed against
Sideband's real `sense.py`, and the spec §2.A pinned SID subset is confirmed correct, no
corrections needed. A fixture pair is committed.

### 1. Wire format: two msgpack layers, not one

`lxm.fields[LXMF.FIELD_TELEMETRY]` is itself a **msgpack-packed bytes blob**, produced by
`Telemeter.packed()` in Sideband's `sbapp/sideband/sense.py`:

```python
def packed(self):
    packed = {}
    packed[Sensor.SID_TIME] = int(time.time())          # always present
    for sensor in self.sensors:
        if self.sensors[sensor].active:
            packed[self.sensors[sensor].sid] = self.sensors[sensor].pack()
    return umsgpack.packb(packed)
```

Sideband's own receive path confirms this is the value under the field key, not the field
key wrapped a second time by LXMF itself:

```python
# sbapp/sideband/core.py L1522-1524, L3115-3121
if LXMF.FIELD_TELEMETRY in lxm_fields:
    telemeter = Telemeter.from_packed(lxm_fields[LXMF.FIELD_TELEMETRY])
```

So the decode boundary is exactly what spec §2.An assumes: `decode_field_telemetry(raw)` takes
`raw = lxm.fields[LXMF.FIELD_TELEMETRY]` (already extracted as raw `bytes` by the `lxmf`
package's own field-dict unpacking), and msgpack-unpacks `raw` **once** to get
`{sid: per_sensor_packed_value, ...}`. There is no third layer, each `per_sensor_packed_value`
is whatever that sensor's own `pack()` returns (a scalar, list, or list of `struct.pack`-produced
`bytes` for `Location`), already msgpack-encodable as-is by the outer `packb`.

**Confirmed:** standard MessagePack, not an RNS-specific dialect. `bridge/tests/fixtures/sideband_telemetry_location_battery_temp.bin`
was built with RNS's own vendored packer (`RNS.vendor.umsgpack`, matching what Sideband
actually calls) and round-tripped successfully through the plain `msgpack` PyPI package (the
one WP2 will actually depend on per spec R4), same bytes, same decoded structure both ways.
`msgpack==1.2.1` was used for the cross-check; pin it in `bridge/requirements.txt` when WP2 adds
the dependency.

### 2. SID map: spec §2.A pinned subset confirmed correct, real integer values

Read 2026-08-14 from `markqvist/Sideband@master:sbapp/sideband/sense.py` (`class Sensor`, L199-224):

| SID name | Int value | Spec §2.A telemetryType | Confirmed? |
|---|---|---|---|
| `SID_LOCATION` | `0x02` | → `position` (not telemetry; §3/§4 own path) | ✅ |
| `SID_BATTERY` | `0x04` | `rns_battery` | ✅ |
| `SID_TEMPERATURE` | `0x07` | `rns_temperature` | ✅ |
| `SID_HUMIDITY` | `0x08` | `rns_humidity` | ✅ |
| `SID_PRESSURE` | `0x03` | `rns_pressure` | ✅ |
| `SID_POWER_CONSUMPTION` | `0x11` | `rns_power_in` | ✅ |
| `SID_POWER_PRODUCTION` | `0x12` | `rns_power_out` | ✅ |
| `SID_PROCESSOR` | `0x13` | `rns_cpu` | ✅ |
| `SID_RAM` | `0x14` | `rns_ram` | ✅ |
| `SID_NVM` | `0x15` | `rns_nvm` | ✅ |
| `SID_PHYSICAL_LINK` | `0x05` | `rns_link_rssi` / `rns_link_snr` / `rns_link_q` (one sensor, 3 telemetry rows) | ✅ |
| `SID_TIME` | `0x01` | not in spec's pinned list; always present in every `Telemeter.packed()` output, carry it as the top-level `ts`, not a sensor row | (new finding, see §4) |

No corrections to spec §2.A were needed, every pinned name/value pair matches the real
`sense.py`. One addition worth calling out: `SID_TIME` (`0x01`) is unconditionally included by
`Telemeter.packed()` regardless of which sensors are active, so every real Sideband
`FIELD_TELEMETRY` blob carries it. It should feed `decode_field_telemetry`'s top-level `ts`,
not become a `sensors` entry or an `rns_*` telemetryType.

Unpinned SIDs that exist in `sense.py` but are **out of Phase 3 scope** (confirmed present,
not wired): `SID_ACCELERATION` (0x06), `SID_MAGNETIC_FIELD` (0x09), `SID_AMBIENT_LIGHT` (0x0A),
`SID_GRAVITY` (0x0B), `SID_ANGULAR_VELOCITY` (0x0C), `SID_PROXIMITY` (0x0E),
`SID_INFORMATION` (0x0F), `SID_RECEIVED` (0x10), `SID_TANK` (0x16), `SID_FUEL` (0x17),
`SID_LXMF_PROPAGATION` (0x18), `SID_RNS_TRANSPORT` (0x19), `SID_CONNECTION_MAP` (0x1A),
`SID_CUSTOM` (0xFF), `SID_NONE` (0x00). These must decode as "unknown, skip" per spec, never
crash the decoder, the fixture includes one of these (`SID_AMBIENT_LIGHT`, 0x0A) specifically
to exercise that path.

### 3. Per-sensor value shapes (pinned subset), read from `sense.py` `pack()`/`unpack()`

- **`Battery` (0x04).** `pack()` → `[charge_percent: float(round1), charging: bool, temperature: float|None]`
  (list, positional, `temperature` is commonly `None` on non-Android platforms). Map
  `charge_percent` → `rns_battery` value, unit `%`.
- **`Temperature` (0x07).** `pack()` → bare `float` (celsius). Map directly → `rns_temperature`, unit `c`.
- **`Humidity` (0x08).** `pack()` → bare `float` (`percent_relative`). → `rns_humidity`, unit `%`.
- **`Pressure` (0x03).** `pack()` → bare `float` (`mbar`). → `rns_pressure`, unit `mbar`.
- **`PowerConsumption` (0x11) / `PowerProduction` (0x12).** `pack()` → `list[[type_label, [watts, custom_icon]], ...]`
  — a **map-shaped list**, not a scalar (Sideband supports multiple named consumers/producers
  per device; `type_label` defaults to `0x00` meaning "the" single consumer/producer). WP2
  should sum or take the `0x00`-keyed entry for the single-value `rns_power_in`/`rns_power_out`
  telemetry row, and may drop named sub-consumers as out of scope for Phase 3's flat
  telemetry-row model.
- **`Processor` (0x13) / `RandomAccessMemory` (0x14) / `NonVolatileMemory` (0x15).** Same
  `list[[type_label, [...]], ...]` shape as Power*. Processor's inner list is
  `[current_load, load_avgs, clock]`; RAM/NVM's is `[capacity, used]`. Same `0x00`-default
  reduction applies for `rns_cpu`/`rns_ram`/`rns_nvm`.
- **`PhysicalLink` (0x05).** `pack()` → `[rssi, snr, q]` (list, positional, any may be `None`).
  Fan out to three telemetry rows: `rns_link_rssi`, `rns_link_snr`, `rns_link_q`.

### 4. `Location.pack()` layout, confirmed field order, confirmed encoding

From `sense.py` `class Location`, `pack()`/`unpack()` (verbatim, read 2026-08-14):

```python
def pack(self):
    d = self.data
    return [
        struct.pack("!i", int(round(d["latitude"], 6) * 1e6)),
        struct.pack("!i", int(round(d["longitude"], 6) * 1e6)),
        struct.pack("!i", int(round(d["altitude"], 2) * 1e2)),
        struct.pack("!I", int(round(d["speed"], 2) * 1e2)),
        struct.pack("!i", int(round(d["bearing"], 2) * 1e2)),
        struct.pack("!H", int(round(d["accuracy"], 2) * 1e2)),
        d["last_update"],
    ]
```

Confirmed against the design doc's claimed order (**lat, lon, altitude, speed, bearing,
accuracy, timestamp**), matches exactly, with `last_update` as the 7th element serving as the
"timestamp" (unix seconds, plain `int`, **not** struct-packed).

Important detail the design doc didn't spell out: elements 0-5 are **not** plain msgpack
numbers, each is a fixed-width big-endian `struct.pack` byte string (`!i`=4B signed,
`!I`=4B unsigned, `!H`=2B unsigned), individually scaled (lat/lon ×1e6, altitude/speed/bearing/
accuracy ×1e2) before packing, and msgpack encodes those Python `bytes` values as **bin**
type entries inside the list, so `Location.pack()`'s msgpack shape is
`[bin4, bin4, bin4, bin4, bin4, bin2, int]`, not `[float, float, float, float, float, float, int]`.
A decoder that assumes floats will silently get garbage; it MUST `struct.unpack` each bin
element with the matching format string and divide back down by the same scale factor. Decode is
exactly `Location.unpack()` above, verbatim, WP2 should port it byte-for-byte rather than
reinvent it.

### 5. Fixture

- **File:** `bridge/tests/fixtures/sideband_telemetry_location_battery_temp.bin` (75 bytes)
- **Expected:** `bridge/tests/fixtures/sideband_telemetry_location_battery_temp.expected.json`
- **Real or synthetic:** **synthetic, spec-faithful**, no live Sideband instance was available
  in this environment (per R5/timebox, none was attempted). The fixture bytes were produced by
  hand-replicating `Telemeter.packed()` / each pinned sensor's `pack()` method **verbatim**
  (same struct format strings, same scale factors, same outer-dict shape) against the real
  `sense.py` source fetched from `markqvist/Sideband@master`, then packed with RNS's own
  vendored `umsgpack` (`RNS.vendor.umsgpack`, the exact module Sideband imports as `umsgpack`)
  to guarantee byte-for-byte wire fidelity, not a hand-rolled encoding.
- **Contents:** `SID_TIME` (0x01, ts=1755123456) + `SID_LOCATION` (0x02, lat 37.7749 /
  lon -122.4194 / altitude 15.5m / speed 1.2 / bearing 270.0 / accuracy 8.5 / same ts) +
  `SID_BATTERY` (0x04, 82.5%, not charging, temperature `null`) + `SID_TEMPERATURE` (0x07,
  24.3°C) + `SID_AMBIENT_LIGHT` (0x0A, 350, deliberately an **unpinned** SID, to assert the
  decoder's "unknown SID → skip, never crash" behavior).
- **Verification:** the generator script round-tripped the blob through both
  `RNS.vendor.umsgpack.unpackb` and the plain `msgpack` PyPI package
  (`msgpack.unpackb(raw, raw=False, strict_map_key=False)`) and asserted the decoded values
  matched the source data exactly, before writing the fixture files.

### 6. Exact decode approach for WP2

**Module:** `bridge/meshmonitor_rns_bridge/sideband_telemetry.py` (new, per spec §2.A).

**Signature:**

```python
def decode_field_telemetry(raw: bytes) -> dict:
    """
    raw: the bytes value at lxm_fields[LXMF.FIELD_TELEMETRY] (already extracted
         by the `lxmf` package's field-dict unpacking -- NOT the whole LXMF
         message, just this one field's value).

    Returns:
        {
          "ts": int | None,                     # from SID_TIME, if present
          "location": {                          # only if SID_LOCATION present
            "lat": float, "lon": float, "altitude": float,
            "speed": float, "bearing": float, "accuracy": float,
          } | None,
          "sensors": {                           # pinned subset only
            "<telemetryType>": {"value": float, "unit": str | None},
            ...
          },
        }

    Never raises. A malformed/truncated `raw` (bad outer msgpack, or a pinned
    SID whose inner shape doesn't match expectations) is logged and yields
    the partial/empty result -- it must never crash the LXMF delivery
    callback, since Reticulum peers are untrusted by construction.
    """
```

**Steps:**
1. `outer = msgpack.unpackb(raw, raw=False, strict_map_key=False)` inside a `try/except`
   (`Exception` → log at `RNS.LOG_ERROR`-equivalent, return `{"ts": None, "location": None, "sensors": {}}`).
   `outer` is `{sid: per_sensor_value, ...}` with **integer** keys (msgpack int, not string
   `strict_map_key=False` is required or the standard `msgpack` package raises on non-str keys).
2. Pull `ts = outer.get(SID_TIME)` (0x01) if present, else `None`.
3. If `SID_LOCATION` (0x02) present: `struct.unpack` each of the first 6 list elements per the
   format table in §4, divide by the matching scale (1e6 for lat/lon, 1e2 for the rest), take
   element 6 verbatim as part of the location dict if useful, else drop it (its info is
   already in top-level `ts` in practice since Sideband sets both from the same clock read).
   Any exception decoding an individual field → drop `location` entirely for this message
   (don't half-fill it), continue to sensors.
4. For each remaining `sid` in `outer`: look up in a `SID_TO_TYPE: dict[int, str]` module
   constant built from the pinned table in §2 (excludes `SID_TIME`/`SID_LOCATION`, those are
   handled specially in steps 2-3). If `sid` is not a key, `continue` (unknown SID, silently
   skipped, this is the fixture's `SID_AMBIENT_LIGHT` case). If it is a key:
   - Scalar sensors (`Temperature`, `Humidity`, `Pressure`) → `sensors[name] = {"value": float(v), "unit": <fixed>}`.
   - `Battery` → `sensors["rns_battery"] = {"value": float(v[0]), "unit": "%"}` (index 0 =
      214 ; ignore  215 / 216  sub-fields for Phase 3's flat model, or
     fold  217  into a boolean row later if product wants it — out of WP0 scope to decide).
   - `PhysicalLink` → fan out to 3 rows (`rns_link_rssi`, `rns_link_snr`, `rns_link_q`) from
      222 ,  223 ,  224  respectively, each optional (skip a row if its value is  225 ).
   - `Power*`/`Processor`/`RAM`/`NVM` (the `list[[type_label, [...]], ...]` shape) → find the
     entry whose  231 , use its first inner value (watts / current_load / capacity
     — WP2 implementer's call whether RAM/NVM should emit  232  or  233 ; not decided by
     this spike, flag it as an open call in the WP2 PR description).
   - Any per-sensor `IndexError`/`TypeError`/`KeyError` → skip that one sensor, keep going
     (never let one malformed sensor entry drop the whole message).
5. Return the assembled dict. The caller (`rns_manager.py`'s LXMF delivery path) is responsible
   for turning this into the `TYPE_TELEMETRY` event per spec §2.C, and, per R3, for
   intercepting `FIELD_TELEMETRY` **before** it reaches the existing generic
   `_sanitize_lxmf_fields` bytes-collapsing path (confirmed in this spike: `FIELD_TELEMETRY`
   is not in `_FIELD_NAMES`, and the fixture's 75-byte blob is already over
   `_MAX_INLINE_BYTES` (32), so unmodified it would currently collapse to
   `{"bytesLength": 75}` under the generic handler, WP2 must special-case it, not rely on the
   generic path producing anything useful).

**Constants to define in the new module** (values confirmed in §2):

```python
SID_TIME              = 0x01
SID_LOCATION          = 0x02
SID_PRESSURE          = 0x03
SID_BATTERY           = 0x04
SID_PHYSICAL_LINK     = 0x05
SID_TEMPERATURE       = 0x07
SID_HUMIDITY          = 0x08
SID_POWER_CONSUMPTION = 0x11
SID_POWER_PRODUCTION  = 0x12
SID_PROCESSOR         = 0x13
SID_RAM               = 0x14
SID_NVM               = 0x15

SID_TO_TYPE = {
    SID_BATTERY: "rns_battery",
    SID_TEMPERATURE: "rns_temperature",
    SID_HUMIDITY: "rns_humidity",
    SID_PRESSURE: "rns_pressure",
    SID_POWER_CONSUMPTION: "rns_power_in",
    SID_POWER_PRODUCTION: "rns_power_out",
    SID_PROCESSOR: "rns_cpu",
    SID_RAM: "rns_ram",
    SID_NVM: "rns_nvm",
    # SID_PHYSICAL_LINK handled specially (fans out to 3 types)
}
```

**Bottom line:** proceed to WP2 with the fixture, the confirmed SID map (no corrections
needed), and the `Location.pack()`/`unpack()` byte layout above ported verbatim. `msgpack`
needs adding to `bridge/requirements.txt` (declared explicitly per spec R4); `msgpack==1.2.1`
was the version used for the cross-check in this spike.
