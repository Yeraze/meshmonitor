"""Unit tests for meshmonitor_rns_bridge.ws_server: token comparison, plus (Phase
2, #3960 WP1) the seven new LXMF command handlers' happy/error paths.

Security review finding (token comparison): the bridge binds 0.0.0.0 by default
(reachable beyond loopback in the container deployment), so comparing the
shared-secret `hello.token` with a plain `==` is vulnerable to a same-network
timing attack. `_tokens_match()` uses `hmac.compare_digest()` instead; these tests
pin the *behavior* (correct token authenticates, wrong/missing/malformed token is
rejected) which must stay identical to the old `!=` check -- only the comparison
mechanism changed.

Deliberately does not (and cannot, without instrumentation the stdlib doesn't expose)
assert timing itself; that property comes from using `hmac.compare_digest`, which is
exercised here to at least confirm it's actually being called with the right
arguments and that it round-trips both matching and non-matching cases correctly.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from meshmonitor_rns_bridge import protocol
from meshmonitor_rns_bridge.rns_manager import OwnModeRequiredError
from meshmonitor_rns_bridge.ws_server import (
    _handle_announce_self,
    _handle_get_device_info,
    _handle_get_identity,
    _handle_get_radio_config,
    _handle_import_identity,
    _handle_send_lxmf,
    _handle_set_display_name,
    _handle_set_propagation_node,
    _handle_set_radio_config,
    _handle_sync_propagation,
    _parse_own_params,
    _tokens_match,
)


def test_correct_token_matches():
    assert _tokens_match("s3cret", "s3cret") is True


def test_wrong_token_does_not_match():
    assert _tokens_match("wrong", "s3cret") is False


def test_missing_token_does_not_match():
    assert _tokens_match(None, "s3cret") is False


def test_non_string_token_does_not_match():
    # A malformed hello could send token as a number/list/dict after JSON decode --
    # the old `!=` comparison rejected these too (no type coercion), preserve that.
    assert _tokens_match(12345, "s3cret") is False
    assert _tokens_match(["s3cret"], "s3cret") is False
    assert _tokens_match({"token": "s3cret"}, "s3cret") is False


def test_empty_token_does_not_match_nonempty_expected():
    assert _tokens_match("", "s3cret") is False


def test_uses_constant_time_compare():
    """Pins the mechanism, not just the outcome: a plain `==` regression would still
    pass every behavioral test above, so assert hmac.compare_digest is actually what
    performs the comparison."""
    with patch("meshmonitor_rns_bridge.ws_server.hmac.compare_digest", return_value=True) as mock_compare:
        assert _tokens_match("anything", "s3cret") is True
        mock_compare.assert_called_once_with(b"anything", b"s3cret")


# --------------------------------------------------------------------------
# Phase 2 (LXMF messaging, #3960 WP1): the seven new command handlers.
# Each is exercised happy-path (manager call succeeds, req id echoed back)
# and error-path (manager raises -> `error` envelope, req id echoed, code ==
# LXMF_COMMAND_FAILED) per build spec §3.5's "exception-wrapped" contract.
# The manager itself is a MagicMock -- these tests pin ws_server.py's
# dispatch/response shape, not rns_manager.py's LXMF behavior (that's
# test_rns_manager.py / the dual-rnsd integration test's job).
# --------------------------------------------------------------------------


class _FakeWebSocket:
    """Captures every envelope `_safe_send` writes, decoded back to a dict so
    assertions read field values rather than raw JSON strings."""

    def __init__(self) -> None:
        self.sent: list = []

    def send(self, raw: str) -> None:
        self.sent.append(protocol.decode(raw))

    @property
    def last(self) -> dict:
        assert self.sent, "no envelope was sent"
        return self.sent[-1]


@pytest.fixture
def ws():
    return _FakeWebSocket()


@pytest.fixture
def manager():
    return MagicMock()


def test_send_lxmf_happy_path_responds_with_sending_delivery_state(ws, manager):
    manager.send_lxmf.return_value = "1a2b3c4d5e6f708192a3b4c5d6e7f809"
    req = {
        "id": "c3",
        "type": protocol.TYPE_SEND_LXMF,
        "to": "112233445566778899aabbccddeeff0",
        "title": "Hello",
        "content": "Hello!",
        "fields": {"thread": "abc"},
        "method": "opportunistic",
        "propagationNode": None,
    }
    _handle_send_lxmf(ws, manager, req)

    manager.send_lxmf.assert_called_once_with(
        to_hash_hex="112233445566778899aabbccddeeff0",
        title="Hello",
        content="Hello!",
        fields={"thread": "abc"},
        method="opportunistic",
        propagation_node_hex=None,
    )
    assert ws.last["type"] == protocol.TYPE_DELIVERY_STATE
    assert ws.last["id"] == "c3"
    assert ws.last["hash"] == "1a2b3c4d5e6f708192a3b4c5d6e7f809"
    assert ws.last["state"] == "sending"


def test_send_lxmf_error_path_responds_with_error(ws, manager):
    manager.send_lxmf.side_effect = ValueError("no known path/identity for destination")
    req = {"id": "c3", "type": protocol.TYPE_SEND_LXMF, "to": "unknown", "title": "", "content": ""}
    _handle_send_lxmf(ws, manager, req)

    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["id"] == "c3"
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED
    assert "no known path" in ws.last["message"]


def test_announce_self_happy_path_responds_ready(ws, manager):
    _handle_announce_self(ws, manager, {"id": "c4", "type": protocol.TYPE_ANNOUNCE_SELF})
    manager.announce_self.assert_called_once_with()
    assert ws.last["type"] == protocol.TYPE_READY
    assert ws.last["id"] == "c4"


def test_announce_self_error_path_responds_with_error(ws, manager):
    manager.announce_self.side_effect = RuntimeError("LXMF router not started")
    _handle_announce_self(ws, manager, {"id": "c4", "type": protocol.TYPE_ANNOUNCE_SELF})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["id"] == "c4"
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


def test_set_display_name_happy_path_responds_ready(ws, manager):
    req = {"id": "c5", "type": protocol.TYPE_SET_DISPLAY_NAME, "displayName": "Alice"}
    _handle_set_display_name(ws, manager, req)
    manager.set_display_name.assert_called_once_with("Alice")
    assert ws.last["type"] == protocol.TYPE_READY
    assert ws.last["id"] == "c5"


def test_set_display_name_error_path_responds_with_error(ws, manager):
    manager.set_display_name.side_effect = RuntimeError("boom")
    _handle_set_display_name(ws, manager, {"id": "c5", "type": protocol.TYPE_SET_DISPLAY_NAME, "displayName": "x"})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


def test_sync_propagation_happy_path_responds_ready(ws, manager):
    _handle_sync_propagation(ws, manager, {"id": "c6", "type": protocol.TYPE_SYNC_PROPAGATION})
    manager.sync_propagation.assert_called_once_with()
    assert ws.last["type"] == protocol.TYPE_READY
    assert ws.last["id"] == "c6"


def test_sync_propagation_error_path_responds_with_error(ws, manager):
    manager.sync_propagation.side_effect = RuntimeError("no propagation node configured")
    _handle_sync_propagation(ws, manager, {"id": "c6", "type": protocol.TYPE_SYNC_PROPAGATION})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


def test_set_propagation_node_happy_path_responds_ready(ws, manager):
    req = {
        "id": "c7",
        "type": protocol.TYPE_SET_PROPAGATION_NODE,
        "destinationHash": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    }
    _handle_set_propagation_node(ws, manager, req)
    manager.set_propagation_node.assert_called_once_with("9f8e7d6c5b4a39281706f5e4d3c2b1a0")
    assert ws.last["type"] == protocol.TYPE_READY
    assert ws.last["id"] == "c7"


def test_set_propagation_node_error_path_responds_with_error(ws, manager):
    manager.set_propagation_node.side_effect = ValueError("destinationHash is required")
    _handle_set_propagation_node(ws, manager, {"id": "c7", "type": protocol.TYPE_SET_PROPAGATION_NODE})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


def test_get_identity_happy_path_responds_with_public_info_only(ws, manager):
    manager.get_identity_info.return_value = {
        "destinationHash": "112233445566778899aabbccddeeff0",
        "identityHash": "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
        "displayName": "Alice",
    }
    _handle_get_identity(ws, manager, {"id": "c8", "type": protocol.TYPE_GET_IDENTITY})
    assert ws.last["type"] == protocol.TYPE_STATUS
    assert ws.last["id"] == "c8"
    assert ws.last["destinationHash"] == "112233445566778899aabbccddeeff0"
    assert ws.last["displayName"] == "Alice"
    # R2/R5: no private-key field must ever appear on this reply.
    assert "privateKey" not in ws.last
    assert "privateKeyB64" not in ws.last


def test_get_identity_error_path_responds_with_error(ws, manager):
    manager.get_identity_info.side_effect = RuntimeError("LXMF router not started")
    _handle_get_identity(ws, manager, {"id": "c8", "type": protocol.TYPE_GET_IDENTITY})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


def test_import_identity_happy_path_responds_ready(ws, manager):
    req = {"id": "c9", "type": protocol.TYPE_IMPORT_IDENTITY, "privateKeyB64": "c29tZWtleWJ5dGVz"}
    _handle_import_identity(ws, manager, req)
    manager.import_identity.assert_called_once_with("c29tZWtleWJ5dGVz")
    assert ws.last["type"] == protocol.TYPE_READY
    assert ws.last["id"] == "c9"


def test_import_identity_error_path_responds_with_error(ws, manager):
    manager.import_identity.side_effect = ValueError("invalid private key")
    _handle_import_identity(ws, manager, {"id": "c9", "type": protocol.TYPE_IMPORT_IDENTITY, "privateKeyB64": "!!"})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.LXMF_COMMAND_FAILED


# --------------------------------------------------------------------------
# Phase 3 (own mode + RNode radio config/device info, #3960 WP1): three new
# command handlers. Each is exercised happy-path, own-mode-required
# (typed error), and generic-failure paths, per build spec §2.B "return a
# typed own-mode-required error, never crash".
# --------------------------------------------------------------------------


def test_parse_own_params_extracts_known_wire_fields():
    req = {
        "frequency": 914875000,
        "bandwidth": 125000,
        "spreadingFactor": 8,
        "codingRate": 5,
        "txPower": 17,
        "stAlock": 33.3,
        "ltAlock": None,
        "unrelatedField": "ignored",
    }
    assert _parse_own_params(req) == {
        "frequency": 914875000,
        "bandwidth": 125000,
        "sf": 8,
        "cr": 5,
        "txpower": 17,
        "st_alock": 33.3,
    }


def test_parse_own_params_returns_none_when_no_fields_present():
    assert _parse_own_params({"mode": "own", "device": "/dev/ttyUSB0"}) is None


def test_get_radio_config_happy_path(ws, manager):
    manager.get_radio_config.return_value = {
        "frequency": 914875000,
        "bandwidth": 125000,
        "spreadingFactor": 8,
        "codingRate": 5,
        "txPower": 17,
        "stAlock": None,
        "ltAlock": None,
        "radioState": True,
    }
    _handle_get_radio_config(ws, manager, {"id": "c10", "type": protocol.TYPE_GET_RADIO_CONFIG})
    assert ws.last["type"] == protocol.TYPE_RADIO_CONFIG
    assert ws.last["id"] == "c10"
    assert ws.last["frequency"] == 914875000
    assert ws.last["radioState"] is True


def test_get_radio_config_own_mode_required(ws, manager):
    manager.get_radio_config.side_effect = OwnModeRequiredError("not in own mode")
    _handle_get_radio_config(ws, manager, {"id": "c10", "type": protocol.TYPE_GET_RADIO_CONFIG})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["id"] == "c10"
    assert ws.last["code"] == protocol.OWN_MODE_REQUIRED


def test_get_radio_config_generic_failure(ws, manager):
    manager.get_radio_config.side_effect = RuntimeError("boom")
    _handle_get_radio_config(ws, manager, {"id": "c10", "type": protocol.TYPE_GET_RADIO_CONFIG})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.RNODE_COMMAND_FAILED


def test_set_radio_config_happy_path_extracts_params_and_forwards(ws, manager):
    manager.set_radio_config.return_value = {
        "frequency": 915000000,
        "bandwidth": 125000,
        "spreadingFactor": 8,
        "codingRate": 5,
        "txPower": 20,
        "stAlock": None,
        "ltAlock": None,
        "radioState": True,
    }
    req = {
        "id": "c11",
        "type": protocol.TYPE_SET_RADIO_CONFIG,
        "frequency": 915000000,
        "txPower": 20,
        "bandwidth": None,
    }
    _handle_set_radio_config(ws, manager, req)

    manager.set_radio_config.assert_called_once_with({"frequency": 915000000, "txPower": 20})
    assert ws.last["type"] == protocol.TYPE_RADIO_CONFIG
    assert ws.last["id"] == "c11"
    assert ws.last["txPower"] == 20


def test_set_radio_config_own_mode_required(ws, manager):
    manager.set_radio_config.side_effect = OwnModeRequiredError("not in own mode")
    _handle_set_radio_config(ws, manager, {"id": "c11", "type": protocol.TYPE_SET_RADIO_CONFIG, "frequency": 915000000})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.OWN_MODE_REQUIRED


def test_set_radio_config_generic_failure(ws, manager):
    manager.set_radio_config.side_effect = RuntimeError("boom")
    _handle_set_radio_config(ws, manager, {"id": "c11", "type": protocol.TYPE_SET_RADIO_CONFIG, "frequency": 1})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.RNODE_COMMAND_FAILED


def test_get_device_info_happy_path(ws, manager):
    manager.get_device_info.return_value = {
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
    _handle_get_device_info(ws, manager, {"id": "c12", "type": protocol.TYPE_GET_DEVICE_INFO})
    assert ws.last["type"] == protocol.TYPE_DEVICE_INFO
    assert ws.last["id"] == "c12"
    assert ws.last["firmwareVersion"] == "1.52"
    assert ws.last["csma"]["cwBand"] == 2


def test_get_device_info_own_mode_required(ws, manager):
    manager.get_device_info.side_effect = OwnModeRequiredError("not in own mode")
    _handle_get_device_info(ws, manager, {"id": "c12", "type": protocol.TYPE_GET_DEVICE_INFO})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.OWN_MODE_REQUIRED


def test_get_device_info_generic_failure(ws, manager):
    manager.get_device_info.side_effect = RuntimeError("boom")
    _handle_get_device_info(ws, manager, {"id": "c12", "type": protocol.TYPE_GET_DEVICE_INFO})
    assert ws.last["type"] == protocol.TYPE_ERROR
    assert ws.last["code"] == protocol.RNODE_COMMAND_FAILED
