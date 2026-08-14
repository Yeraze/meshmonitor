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

import LXMF
import RNS
import pytest

from meshmonitor_rns_bridge.rns_manager import (
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
