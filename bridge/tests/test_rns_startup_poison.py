"""Issue #5955: a start() that fails after RNS.Reticulum() was entered poisons the
process. RNS keeps its process-wide singleton (and, in attach mode, may hold the
shared-instance listener), so a retry would raise "Attempt to reinitialise
Reticulum" and hide the real cause. The manager keeps returning the original
failure and run_dispatcher() stops so __main__ exits for a supervisor restart.

RNS.Reticulum is always mocked: no real singleton is ever constructed here.
"""

from __future__ import annotations

import threading
from unittest.mock import patch

import pytest
import RNS

from meshmonitor_rns_bridge.config import BridgeConfig
from meshmonitor_rns_bridge.rns_manager import RNSManager, RNSStartupError


def _attach_manager(configdir: str) -> RNSManager:
    return RNSManager(BridgeConfig(token="s3cret", mode="attach", rns_config_dir=configdir))


def test_failed_construction_poisons_and_later_starts_return_the_original_error(tmp_path):
    manager = _attach_manager(str(tmp_path))
    with patch("RNS.Reticulum", side_effect=OSError(30, "Read-only file system: '/rns/storage'")) as ctor:
        with pytest.raises(RNSStartupError) as first:
            manager.start()
        assert first.value.code == "RNS_INIT_FAILED"
        assert manager.poisoned
        assert manager.poisoned_event.is_set()

        with pytest.raises(RNSStartupError) as second:
            manager.start()

    # The constructor ran once; the retry never reached it, so no
    # "Attempt to reinitialise Reticulum" can mask the real cause.
    assert ctor.call_count == 1
    assert second.value.code == "RNS_INIT_FAILED"
    assert "Read-only file system" in second.value.message
    assert "restarting" in second.value.message
    assert not manager.started


def test_no_shared_instance_failure_poisons(tmp_path):
    manager = _attach_manager(str(tmp_path))
    with patch("RNS.Reticulum", side_effect=SystemError("no shared instance")):
        with pytest.raises(RNSStartupError) as excinfo:
            manager.start()
    assert excinfo.value.code == "NO_SHARED_INSTANCE"
    assert manager.poisoned


def test_precheck_failure_before_construction_does_not_poison(tmp_path):
    manager = _attach_manager(str(tmp_path / "missing"))
    with patch("RNS.Reticulum") as ctor:
        with pytest.raises(RNSStartupError) as excinfo:
            manager.start()
        assert excinfo.value.code == "CONFIGDIR_UNREADABLE"
        ctor.assert_not_called()
    assert not manager.poisoned
    assert not manager.poisoned_event.is_set()


def test_failure_after_successful_construction_also_poisons(tmp_path):
    manager = _attach_manager(str(tmp_path))
    with patch("RNS.Reticulum"), patch.object(RNS.Transport, "register_announce_handler"), patch.object(
        manager, "_start_lxmf", side_effect=RNSStartupError("RNS_INIT_FAILED", "LXMF router failed")
    ):
        with pytest.raises(RNSStartupError):
            manager.start()
    assert manager.poisoned


def test_dispatcher_returns_the_error_then_stops(tmp_path):
    manager = _attach_manager(str(tmp_path))
    manager.POISON_EXIT_GRACE_S = 0.01
    stop_event = threading.Event()
    errors: list = []

    def _request():
        try:
            manager.request_start()
        except RNSStartupError as e:
            errors.append(e)

    with patch("RNS.Reticulum", side_effect=OSError(30, "Read-only file system")):
        dispatcher = threading.Thread(target=manager.run_dispatcher, args=(stop_event,), daemon=True)
        dispatcher.start()
        requester = threading.Thread(target=_request, daemon=True)
        requester.start()
        requester.join(timeout=5)
        dispatcher.join(timeout=5)

    assert len(errors) == 1 and errors[0].code == "RNS_INIT_FAILED"
    assert stop_event.is_set()
    assert not dispatcher.is_alive()


def test_dispatcher_keeps_running_after_a_retryable_failure(tmp_path):
    manager = _attach_manager(str(tmp_path / "missing"))
    stop_event = threading.Event()
    dispatcher = threading.Thread(target=manager.run_dispatcher, args=(stop_event,), daemon=True)
    dispatcher.start()
    try:
        with pytest.raises(RNSStartupError) as excinfo:
            manager.request_start()
        assert excinfo.value.code == "CONFIGDIR_UNREADABLE"
        assert not stop_event.wait(0.3)
        assert dispatcher.is_alive()
    finally:
        stop_event.set()
        dispatcher.join(timeout=5)
