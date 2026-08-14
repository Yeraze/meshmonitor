"""Unit tests for meshmonitor_rns_bridge.config: env-driven BridgeConfig
parsing, focused on Phase 3's own-mode additions (#3960 WP1, build spec
§2.B). No pre-existing test_config.py covered attach/tcp_peer parsing --
this file's scope is limited to what own mode adds, plus enough of the
existing attach/tcp_peer/token contract to pin `load_config()`'s general
shape for anyone extending this file later.
"""

from __future__ import annotations

import pytest

from meshmonitor_rns_bridge import config as bridge_config


def _env(**overrides) -> dict:
    base = {"BRIDGE_TOKEN": "s3cret"}
    base.update(overrides)
    return base


# --------------------------------------------------------------------------
# Baseline: token required, mode defaults, tcp_peer requirement (pins
# existing behavior this file's own-mode tests build on).
# --------------------------------------------------------------------------


def test_missing_token_raises_config_error():
    with pytest.raises(bridge_config.ConfigError):
        bridge_config.load_config({})


def test_default_mode_is_attach():
    cfg = bridge_config.load_config(_env())
    assert cfg.mode == "attach"


def test_own_is_a_valid_mode():
    assert "own" in bridge_config.VALID_MODES


def test_invalid_mode_raises_config_error():
    with pytest.raises(bridge_config.ConfigError):
        bridge_config.load_config(_env(RNS_MODE="bogus"))


# --------------------------------------------------------------------------
# own mode: device path requirement
# --------------------------------------------------------------------------


def test_own_mode_requires_device():
    with pytest.raises(bridge_config.ConfigError, match="RNS_OWN_DEVICE"):
        bridge_config.load_config(_env(RNS_MODE="own"))


def test_own_mode_with_device_succeeds():
    cfg = bridge_config.load_config(_env(RNS_MODE="own", RNS_OWN_DEVICE="/dev/ttyUSB0"))
    assert cfg.mode == "own"
    assert cfg.own_device == "/dev/ttyUSB0"


def test_own_device_empty_string_is_treated_as_missing():
    with pytest.raises(bridge_config.ConfigError, match="RNS_OWN_DEVICE"):
        bridge_config.load_config(_env(RNS_MODE="own", RNS_OWN_DEVICE=""))


def test_attach_mode_ignores_own_device_requirement():
    """own_device isn't required outside own mode -- attach/tcp_peer must
    not be blocked by it being absent."""
    cfg = bridge_config.load_config(_env(RNS_MODE="attach"))
    assert cfg.own_device is None


# --------------------------------------------------------------------------
# own mode: initial radio params (all optional)
# --------------------------------------------------------------------------


def test_own_mode_radio_params_default_to_none():
    cfg = bridge_config.load_config(_env(RNS_MODE="own", RNS_OWN_DEVICE="/dev/ttyUSB0"))
    assert cfg.own_frequency is None
    assert cfg.own_bandwidth is None
    assert cfg.own_sf is None
    assert cfg.own_cr is None
    assert cfg.own_txpower is None
    assert cfg.own_st_alock is None
    assert cfg.own_lt_alock is None


def test_own_mode_radio_params_parsed_when_present():
    cfg = bridge_config.load_config(
        _env(
            RNS_MODE="own",
            RNS_OWN_DEVICE="/dev/ttyUSB0",
            RNS_OWN_FREQUENCY="914875000",
            RNS_OWN_BANDWIDTH="125000",
            RNS_OWN_SF="8",
            RNS_OWN_CR="5",
            RNS_OWN_TXPOWER="17",
            RNS_OWN_ST_ALOCK="33.3",
            RNS_OWN_LT_ALOCK="66.6",
        )
    )
    assert cfg.own_frequency == 914875000
    assert cfg.own_bandwidth == 125000
    assert cfg.own_sf == 8
    assert cfg.own_cr == 5
    assert cfg.own_txpower == 17
    assert cfg.own_st_alock == pytest.approx(33.3)
    assert cfg.own_lt_alock == pytest.approx(66.6)


def test_own_mode_invalid_frequency_raises_config_error():
    with pytest.raises(bridge_config.ConfigError, match="RNS_OWN_FREQUENCY"):
        bridge_config.load_config(
            _env(RNS_MODE="own", RNS_OWN_DEVICE="/dev/ttyUSB0", RNS_OWN_FREQUENCY="not-a-number")
        )


def test_own_mode_invalid_st_alock_raises_config_error():
    with pytest.raises(bridge_config.ConfigError, match="RNS_OWN_ST_ALOCK"):
        bridge_config.load_config(
            _env(RNS_MODE="own", RNS_OWN_DEVICE="/dev/ttyUSB0", RNS_OWN_ST_ALOCK="not-a-number")
        )


# --------------------------------------------------------------------------
# own_radio_params()
# --------------------------------------------------------------------------


def test_own_radio_params_omits_unset_fields():
    cfg = bridge_config.load_config(_env(RNS_MODE="own", RNS_OWN_DEVICE="/dev/ttyUSB0"))
    assert bridge_config.own_radio_params(cfg) == {}


def test_own_radio_params_builds_internal_key_names():
    cfg = bridge_config.load_config(
        _env(
            RNS_MODE="own",
            RNS_OWN_DEVICE="/dev/ttyUSB0",
            RNS_OWN_FREQUENCY="914875000",
            RNS_OWN_SF="8",
            RNS_OWN_ST_ALOCK="33.3",
        )
    )
    assert bridge_config.own_radio_params(cfg) == {
        "frequency": 914875000,
        "sf": 8,
        "st_alock": pytest.approx(33.3),
    }
