"""Unit tests for meshmonitor_rns_bridge.rnode_kiss: pure KISS frame builders
and payload decoders for the RNode radio surface (#3960 Phase 3 WP1).

Every byte vector here is derived by hand from the same formulas the
installed rns==1.4.2 `RNS.Interfaces.RNodeInterface` module uses (see
rnode_kiss.py's module docstring for exactly which methods each builder
mirrors) -- no hardware, no serial I/O, no RNS import at all in this file.
"""

from __future__ import annotations

import pytest

from meshmonitor_rns_bridge import rnode_kiss as kiss


# --------------------------------------------------------------------------
# Framing: escape / unescape
# --------------------------------------------------------------------------


def test_kiss_escape_escapes_fesc_before_fend():
    # 0xDB (FESC) immediately followed by 0xC0 (FEND): escaping FESC first
    # must not touch the TFEND byte it just inserted.
    assert kiss.kiss_escape(bytes([0xDB, 0xC0])) == bytes([0xDB, 0xDD, 0xDB, 0xDC])


def test_kiss_escape_leaves_ordinary_bytes_untouched():
    assert kiss.kiss_escape(bytes([0x01, 0x02, 0x03])) == bytes([0x01, 0x02, 0x03])


def test_kiss_escape_unescape_round_trips():
    data = bytes([0x00, 0xC0, 0xDB, 0xFF, 0xC0, 0xDB, 0x7E])
    assert kiss.kiss_unescape(kiss.kiss_escape(data)) == data


def test_kiss_unescape_handles_tfend_and_tfesc():
    assert kiss.kiss_unescape(bytes([0xDB, 0xDC])) == bytes([0xC0])
    assert kiss.kiss_unescape(bytes([0xDB, 0xDD])) == bytes([0xDB])


# --------------------------------------------------------------------------
# Builders: set commands
# --------------------------------------------------------------------------


def test_build_set_frequency_914_875_mhz():
    # 914875000 Hz = 0x3687E278
    frame = kiss.build_set_frequency(914875000)
    assert frame == bytes([0xC0, 0x01, 0x36, 0x87, 0xE2, 0x78, 0xC0])


def test_build_set_frequency_escapes_payload_bytes_matching_fend_or_fesc():
    # 0xC0DBC0C0 would need every byte escaped if it collided with framing --
    # pick a frequency whose big-endian bytes include 0xC0 and 0xDB to prove
    # escaping actually happens (0xC0DB0000 = 3235905536).
    frame = kiss.build_set_frequency(0xC0DB0000)
    payload = frame[2:-1]
    assert payload == kiss.kiss_escape(bytes([0xC0, 0xDB, 0x00, 0x00]))
    assert frame[0] == kiss.FEND
    assert frame[1] == kiss.CMD_FREQUENCY
    assert frame[-1] == kiss.FEND


def test_build_set_bandwidth_125khz():
    # 125000 Hz = 0x0001E848
    frame = kiss.build_set_bandwidth(125000)
    assert frame == bytes([0xC0, 0x02, 0x00, 0x01, 0xE8, 0x48, 0xC0])


def test_build_set_txpower_is_not_escaped():
    frame = kiss.build_set_txpower(17)
    assert frame == bytes([0xC0, 0x03, 17, 0xC0])


def test_build_set_txpower_raw_byte_matching_fend_is_still_unescaped():
    """Matches RNS's own (unescaped) single-byte commands byte-for-byte --
    this is upstream's actual behavior, not a bug introduced here."""
    frame = kiss.build_set_txpower(0xC0)
    assert frame == bytes([0xC0, 0x03, 0xC0, 0xC0])


def test_build_set_sf():
    frame = kiss.build_set_sf(8)
    assert frame == bytes([0xC0, 0x04, 8, 0xC0])


def test_build_set_cr():
    frame = kiss.build_set_cr(5)
    assert frame == bytes([0xC0, 0x05, 5, 0xC0])


def test_build_set_st_alock_encodes_percent_times_100():
    # 33.3% -> int(33.3*100) = 3329 (float imprecision: 33.3*100 ==
    # 3329.9999999999995, matching RNS's own `int(self.st_alock*100)`
    # truncation exactly) = 0x0D01
    frame = kiss.build_set_st_alock(33.3)
    assert frame == bytes([0xC0, 0x0B, 0x0D, 0x01, 0xC0])


def test_build_set_lt_alock_encodes_percent_times_100():
    # 100.0% -> 10000 = 0x2710
    frame = kiss.build_set_lt_alock(100.0)
    assert frame == bytes([0xC0, 0x0C, 0x27, 0x10, 0xC0])


def test_build_set_radio_state_on():
    frame = kiss.build_set_radio_state(kiss.RADIO_STATE_ON)
    assert frame == bytes([0xC0, 0x06, 0x01, 0xC0])


def test_build_set_radio_state_off():
    frame = kiss.build_set_radio_state(kiss.RADIO_STATE_OFF)
    assert frame == bytes([0xC0, 0x06, 0x00, 0xC0])


# --------------------------------------------------------------------------
# Decoders: fw version / board (mcu+platform)
# --------------------------------------------------------------------------


def test_decode_fw_version():
    assert kiss.decode_fw_version(bytes([1, 52])) == {"major": 1, "minor": 52}


def test_decode_fw_version_rejects_wrong_length():
    with pytest.raises(kiss.KissDecodeError):
        kiss.decode_fw_version(bytes([1]))


@pytest.mark.parametrize(
    ("byte_val", "name"),
    [
        (kiss.PLATFORM_AVR, "avr"),
        (kiss.PLATFORM_ESP32, "esp32"),
        (kiss.PLATFORM_NRF52, "nrf52"),
    ],
)
def test_decode_platform_name_known_values(byte_val, name):
    assert kiss.decode_platform_name(byte_val) == name


def test_decode_platform_name_unknown_returns_none():
    assert kiss.decode_platform_name(0x01) is None


def test_decode_board_combines_mcu_and_platform():
    result = kiss.decode_board(mcu_byte=0x1E, platform_byte=kiss.PLATFORM_ESP32)
    assert result == {"mcu": 0x1E, "platform": "esp32", "platformRaw": kiss.PLATFORM_ESP32}


def test_decode_board_unknown_platform_keeps_raw_byte():
    result = kiss.decode_board(mcu_byte=0x02, platform_byte=0x01)
    assert result == {"mcu": 0x02, "platform": None, "platformRaw": 0x01}


def test_decode_board_handles_none_values():
    result = kiss.decode_board(mcu_byte=None, platform_byte=None)
    assert result == {"mcu": None, "platform": None, "platformRaw": None}


# --------------------------------------------------------------------------
# Decoders: stat reads
# --------------------------------------------------------------------------


def test_decode_stat_bat():
    assert kiss.decode_stat_bat(bytes([0x02, 87])) == {"state": 2, "percent": 87}


def test_decode_stat_bat_clamps_percent_above_100():
    assert kiss.decode_stat_bat(bytes([0x01, 255]))["percent"] == 100


def test_decode_stat_bat_rejects_wrong_length():
    with pytest.raises(kiss.KissDecodeError):
        kiss.decode_stat_bat(bytes([0x01]))


@pytest.mark.parametrize(
    ("raw_byte", "expected_temp"),
    [
        (120, 0),
        (150, 30),
        (90, -30),
        (210, 90),
    ],
)
def test_decode_stat_temp_valid_range(raw_byte, expected_temp):
    assert kiss.decode_stat_temp(bytes([raw_byte])) == expected_temp


@pytest.mark.parametrize("raw_byte", [0, 89, 211, 255])
def test_decode_stat_temp_out_of_range_is_none(raw_byte):
    assert kiss.decode_stat_temp(bytes([raw_byte])) is None


def test_decode_stat_csma():
    assert kiss.decode_stat_csma(bytes([2, 3, 8])) == {"cwBand": 2, "cwMin": 3, "cwMax": 8}


def test_decode_stat_csma_rejects_wrong_length():
    with pytest.raises(kiss.KissDecodeError):
        kiss.decode_stat_csma(bytes([1, 2]))


def test_decode_stat_phyprm():
    # symbolTimeMs raw=32768 (/1000 -> 32.768), symbolRate=976,
    # preambleSymbols=12, preambleTimeMs=393, csmaSlotTimeMs=15, csmaDifsMs=45.
    payload = bytes(
        [
            0x80, 0x00,  # 32768
            0x03, 0xD0,  # 976
            0x00, 0x0C,  # 12
            0x01, 0x89,  # 393
            0x00, 0x0F,  # 15
            0x00, 0x2D,  # 45
        ]
    )
    assert kiss.decode_stat_phyprm(payload) == {
        "symbolTimeMs": 32.768,
        "symbolRate": 976,
        "preambleSymbols": 12,
        "preambleTimeMs": 393,
        "csmaSlotTimeMs": 15,
        "csmaDifsMs": 45,
    }


def test_decode_stat_phyprm_rejects_wrong_length():
    with pytest.raises(kiss.KissDecodeError):
        kiss.decode_stat_phyprm(bytes(11))
