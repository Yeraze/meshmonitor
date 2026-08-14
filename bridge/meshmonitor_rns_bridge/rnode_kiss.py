"""Pure KISS frame builders/decoders for the RNode radio surface (#3960 Phase 3
WP1, build spec §2.B/§2.C, RETICULUM_SOURCE_DESIGN.md §1.2).

This module is the ONLY part of own-mode's radio handling validated in CI --
byte-string builders and payload decoders, exercised against known byte
vectors in test_rnode_kiss.py, with NO serial I/O, NO RNS.Reticulum
construction, and NO hardware/network dependency of any kind (anti-grind
guard, #3960 Phase 3 R1). rns_manager.py's `_start_own()` still uses the
real `RNS.Interfaces.RNodeInterface.RNodeInterface` class (and its own
`setFrequency()`/`setBandwidth()`/etc methods) to actually drive a device --
this module exists as an independently-testable pin of the exact wire
format those methods produce, verified against the installed rns==1.4.2
source (`RNS/Interfaces/RNodeInterface.py`, `class KISS` + `readLoop()`).

Command/constant values are re-declared locally rather than imported from
RNS internals -- same rationale as rns_manager.py's `INTERFACE_MODE_NAMES`
comment: this module must keep working even if a future RNS version
reorders/renames the `KISS` class's attributes, and it must be importable
(for pure unit tests) without RNS's optional `serial` dependency being
installed.

Builder framing rules (verified against RNodeInterface.setFrequency/
setBandwidth/setTXPower/setSpreadingFactor/setCodingRate/setSTALock/
setLTALock/setRadioState): every frame is `FEND + CMD + payload + FEND`.
Multi-byte payloads (frequency, bandwidth, the two airtime locks) are
KISS-escaped; single-byte payloads (TX power, SF, CR, radio state) are
written raw, unescaped -- RNS does this too (a single configuration byte
happening to collide with FEND/FESC is not defended against upstream
either), so builders here match that behavior byte-for-byte rather than
"fixing" it, since the real firmware expects exactly this framing.

Decoder functions take the de-escaped payload bytes already assembled by a
KISS reader (i.e. `command_buffer` in RNodeInterface.readLoop(), AFTER FESC/
TFEND/TFESC substitution) -- escaping/de-escaping is a framing-level concern
handled by `kiss_unescape()` below, kept separate from the semantic decode.
"""

from __future__ import annotations

from typing import Optional

# --------------------------------------------------------------------------
# KISS framing constants (RNS/Interfaces/RNodeInterface.py `class KISS`)
# --------------------------------------------------------------------------

FEND = 0xC0
FESC = 0xDB
TFEND = 0xDC
TFESC = 0xDD

CMD_FREQUENCY = 0x01
CMD_BANDWIDTH = 0x02
CMD_TXPOWER = 0x03
CMD_SF = 0x04
CMD_CR = 0x05
CMD_RADIO_STATE = 0x06
CMD_ST_ALOCK = 0x0B
CMD_LT_ALOCK = 0x0C
CMD_FW_VERSION = 0x50
CMD_PLATFORM = 0x48
CMD_MCU = 0x49
CMD_STAT_BAT = 0x27
CMD_STAT_TEMP = 0x29
CMD_STAT_CSMA = 0x28
CMD_STAT_PHYPRM = 0x26

RADIO_STATE_OFF = 0x00
RADIO_STATE_ON = 0x01
RADIO_STATE_ASK = 0xFF

PLATFORM_AVR = 0x90
PLATFORM_ESP32 = 0x80
PLATFORM_NRF52 = 0x70

_PLATFORM_NAMES = {
    PLATFORM_AVR: "avr",
    PLATFORM_ESP32: "esp32",
    PLATFORM_NRF52: "nrf52",
}

# RNodeInterface.RSSI_OFFSET -- used nowhere in this module today (no RSSI
# decoder is in Phase 3 WP1's scope), kept here anyway as a documented
# constant since it's part of the same byte-format family and a future WP
# decoding CMD_STAT_RSSI will need the identical value.
RSSI_OFFSET = 157


class KissDecodeError(ValueError):
    """Raised when a decoder is given a payload of the wrong length."""


def _require_length(payload: bytes, expected: int, what: str) -> None:
    if len(payload) != expected:
        raise KissDecodeError(f"{what} payload must be {expected} bytes, got {len(payload)}")


# --------------------------------------------------------------------------
# Framing: escape / unescape (RNS `KISS.escape`)
# --------------------------------------------------------------------------


def kiss_escape(data: bytes) -> bytes:
    """Matches `RNS.Interfaces.RNodeInterface.KISS.escape` exactly, including
    order: FESC-escape 0xDB bytes first, THEN escape 0xC0 bytes -- reversing
    the order would double-escape a literal 0xDB that appears immediately
    before a literal 0xC0."""
    data = data.replace(bytes([FESC]), bytes([FESC, TFESC]))
    data = data.replace(bytes([FEND]), bytes([FESC, TFEND]))
    return data


def kiss_unescape(data: bytes) -> bytes:
    """Inverse of `kiss_escape()`. Not used by RNodeInterface itself (its
    readLoop() unescapes byte-by-byte inline as it reads), but provided here
    as the pure, testable counterpart so a full escape/unescape round trip
    can be asserted byte-for-byte."""
    out = bytearray()
    escape = False
    for byte in data:
        if escape:
            if byte == TFEND:
                out.append(FEND)
            elif byte == TFESC:
                out.append(FESC)
            else:
                # Not a real KISS escape sequence -- pass the literal FESC
                # and this byte through unchanged rather than dropping data.
                out.append(FESC)
                out.append(byte)
            escape = False
        elif byte == FESC:
            escape = True
        else:
            out.append(byte)
    if escape:
        out.append(FESC)
    return bytes(out)


def _build_frame(cmd: int, payload: bytes, *, escape_payload: bool) -> bytes:
    body = kiss_escape(payload) if escape_payload else payload
    return bytes([FEND, cmd]) + body + bytes([FEND])


# --------------------------------------------------------------------------
# Builders: Node/bridge -> RNode (set commands)
# --------------------------------------------------------------------------


def build_set_frequency(hz: int) -> bytes:
    """CMD_FREQUENCY: 4-byte big-endian Hz, escaped."""
    payload = bytes(
        [
            (hz >> 24) & 0xFF,
            (hz >> 16) & 0xFF,
            (hz >> 8) & 0xFF,
            hz & 0xFF,
        ]
    )
    return _build_frame(CMD_FREQUENCY, payload, escape_payload=True)


def build_set_bandwidth(hz: int) -> bytes:
    """CMD_BANDWIDTH: 4-byte big-endian Hz, escaped."""
    payload = bytes(
        [
            (hz >> 24) & 0xFF,
            (hz >> 16) & 0xFF,
            (hz >> 8) & 0xFF,
            hz & 0xFF,
        ]
    )
    return _build_frame(CMD_BANDWIDTH, payload, escape_payload=True)


def build_set_txpower(dbm: int) -> bytes:
    """CMD_TXPOWER: single byte, NOT escaped (matches RNS's setTXPower)."""
    return _build_frame(CMD_TXPOWER, bytes([dbm & 0xFF]), escape_payload=False)


def build_set_sf(sf: int) -> bytes:
    """CMD_SF: single byte, NOT escaped (matches RNS's setSpreadingFactor)."""
    return _build_frame(CMD_SF, bytes([sf & 0xFF]), escape_payload=False)


def build_set_cr(cr: int) -> bytes:
    """CMD_CR: single byte, NOT escaped (matches RNS's setCodingRate)."""
    return _build_frame(CMD_CR, bytes([cr & 0xFF]), escape_payload=False)


def build_set_st_alock(percent: float) -> bytes:
    """CMD_ST_ALOCK: short-term airtime limit, percent * 100 as a 2-byte
    big-endian int, escaped. Matches RNS's setSTALock -- callers are
    responsible for skipping this command entirely when the limit is unset
    (None), mirroring `if self.st_alock != None:` upstream."""
    at = int(percent * 100)
    payload = bytes([(at >> 8) & 0xFF, at & 0xFF])
    return _build_frame(CMD_ST_ALOCK, payload, escape_payload=True)


def build_set_lt_alock(percent: float) -> bytes:
    """CMD_LT_ALOCK: long-term airtime limit, same encoding as st_alock."""
    at = int(percent * 100)
    payload = bytes([(at >> 8) & 0xFF, at & 0xFF])
    return _build_frame(CMD_LT_ALOCK, payload, escape_payload=True)


def build_set_radio_state(state: int) -> bytes:
    """CMD_RADIO_STATE: single byte (RADIO_STATE_OFF/ON/ASK), NOT escaped."""
    return _build_frame(CMD_RADIO_STATE, bytes([state & 0xFF]), escape_payload=False)


# --------------------------------------------------------------------------
# Decoders: RNode -> Node/bridge (stat/info reads)
#
# Each takes the de-escaped payload bytes for that command (i.e. what
# RNodeInterface.readLoop() accumulates into `command_buffer` before
# interpreting it) and returns the decoded value(s).
# --------------------------------------------------------------------------


def decode_fw_version(payload: bytes) -> dict:
    """CMD_FW_VERSION: 2 bytes, [major, minor]."""
    _require_length(payload, 2, "CMD_FW_VERSION")
    return {"major": payload[0], "minor": payload[1]}


def decode_platform_name(platform_byte: int) -> Optional[str]:
    """Maps a CMD_PLATFORM byte to a stable name. Unknown platform bytes
    (a future RNode variant) return None rather than raising -- the raw
    byte is still available to the caller separately."""
    return _PLATFORM_NAMES.get(platform_byte)


def decode_board(mcu_byte: Optional[int], platform_byte: Optional[int]) -> dict:
    """CMD_MCU + CMD_PLATFORM combined ("board" info, per build spec §2.B).
    RNS itself never names the MCU byte further (readLoop() just stores it
    raw), so `mcu` round-trips as the raw int; `platform` is named via
    `decode_platform_name()` when recognized, else the raw int is kept as
    `platformRaw` so an unrecognized value is never silently dropped."""
    platform_name = decode_platform_name(platform_byte) if platform_byte is not None else None
    return {
        "mcu": mcu_byte,
        "platform": platform_name,
        "platformRaw": platform_byte,
    }


def decode_stat_bat(payload: bytes) -> dict:
    """CMD_STAT_BAT: 2 bytes, [state, percent]. `percent` is clamped to
    [0, 100] exactly like RNodeInterface.readLoop()'s CMD_STAT_BAT branch."""
    _require_length(payload, 2, "CMD_STAT_BAT")
    state = payload[0]
    percent = payload[1]
    if percent > 100:
        percent = 100
    if percent < 0:
        percent = 0
    return {"state": state, "percent": percent}


def decode_stat_temp(payload: bytes) -> Optional[int]:
    """CMD_STAT_TEMP: 1 byte, chip temperature in degrees C as `byte - 120`.
    Values outside [-30, 90] are considered invalid and decode to None,
    matching RNodeInterface.readLoop()'s CMD_STAT_TEMP branch exactly."""
    _require_length(payload, 1, "CMD_STAT_TEMP")
    temp = payload[0] - 120
    if -30 <= temp <= 90:
        return temp
    return None


def decode_stat_csma(payload: bytes) -> dict:
    """CMD_STAT_CSMA: 3 bytes, [cwBand, cwMin, cwMax]."""
    _require_length(payload, 3, "CMD_STAT_CSMA")
    return {"cwBand": payload[0], "cwMin": payload[1], "cwMax": payload[2]}


def decode_stat_phyprm(payload: bytes) -> dict:
    """CMD_STAT_PHYPRM: 12 bytes, six big-endian u16 fields in this exact
    order (matches RNodeInterface.readLoop()'s CMD_STAT_PHYPRM branch):
    symbol time (ms, divided by 1000), symbol rate (baud), preamble length
    (symbols), preamble time (ms), CSMA slot time (ms), CSMA DIFS time (ms).
    """
    _require_length(payload, 12, "CMD_STAT_PHYPRM")

    def _u16(i: int) -> int:
        return (payload[i] << 8) | payload[i + 1]

    return {
        "symbolTimeMs": _u16(0) / 1000.0,
        "symbolRate": _u16(2),
        "preambleSymbols": _u16(4),
        "preambleTimeMs": _u16(6),
        "csmaSlotTimeMs": _u16(8),
        "csmaDifsMs": _u16(10),
    }
