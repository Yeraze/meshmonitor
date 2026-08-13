"""Process-spawning helpers for the dual-rnsd integration tests.

Every RNS.Reticulum()-touching piece of work here (rnsd itself, the announcer, the
bridge) runs as its own real OS subprocess -- never imported into the pytest process
-- so RNS's process-wide-singleton constraint (WP0 spike evidence §6.4) is satisfied
by construction, not by care at each call site.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

BRIDGE_ROOT = Path(__file__).resolve().parents[2]  # .../bridge
PYTHON = sys.executable

_RETICULUM_SECTION = """\
[reticulum]
  enable_transport = No
  share_instance = {share_instance}
  shared_instance_type = tcp
  shared_instance_port = {rpc_port}
  instance_control_port = {rpc_ctrl_port}

[logging]
  loglevel = 3
"""

_SERVER_INTERFACES_SECTION = """
[interfaces]
  [[TCP Server Interface]]
    type = TCPServerInterface
    interface_enabled = True
    listen_ip = 127.0.0.1
    listen_port = {tcp_port}
"""

_CLIENT_INTERFACES_SECTION = """
[interfaces]
  [[TCP Client Interface]]
    type = TCPClientInterface
    interface_enabled = True
    target_host = 127.0.0.1
    target_port = {target_port}
"""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_port(host: str, port: int, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    last_err: Optional[Exception] = None
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError as e:
            last_err = e
            time.sleep(0.1)
    raise TimeoutError(f"nothing listening on {host}:{port} after {timeout}s ({last_err})")


class _OutputCapture:
    """Drains a subprocess's stdout into a list on a background thread, so `.read()`
    (needed for failure diagnostics) never blocks on a still-running process."""

    def __init__(self, stream) -> None:
        self.lines: list = []
        self._thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
        self._thread.start()

    def _drain(self, stream) -> None:
        try:
            for line in stream:
                self.lines.append(line)
        except (ValueError, OSError):
            pass

    def text(self) -> str:
        return "".join(self.lines)


@dataclass
class RnsdServer:
    """A real `rnsd` subprocess with a TCPServerInterface -- the 'instance A' both the
    bridge (attach mode) and remote peers connect to, per build spec §9 test 1 / WP0
    spike setup."""

    configdir: Path
    tcp_port: int
    rpc_port: int
    rpc_ctrl_port: int
    process: Optional[subprocess.Popen] = None
    _capture: Optional[_OutputCapture] = field(default=None, repr=False)

    def write_config(self) -> None:
        self.configdir.mkdir(parents=True, exist_ok=True)
        body = _RETICULUM_SECTION.format(
            share_instance="Yes", rpc_port=self.rpc_port, rpc_ctrl_port=self.rpc_ctrl_port
        )
        body += _SERVER_INTERFACES_SECTION.format(tcp_port=self.tcp_port)
        (self.configdir / "config").write_text(body)

    def start(self, timeout: float = 10.0) -> None:
        self.write_config()
        self.process = subprocess.Popen(
            ["rnsd", "--config", str(self.configdir)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self._capture = _OutputCapture(self.process.stdout)
        wait_for_port("127.0.0.1", self.tcp_port, timeout)
        wait_for_port("127.0.0.1", self.rpc_port, timeout)

    def stop(self, timeout: float = 5.0) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=timeout)
        self.process = None

    def output(self) -> str:
        return self._capture.text() if self._capture else ""


def write_attach_only_config(configdir: Path, rpc_port: int, rpc_ctrl_port: int) -> None:
    """A config dir for a shared-instance CLIENT that never opens interfaces itself
    (WP0 §2: client instances skip interface creation, guarded by
    `is_shared_instance or is_standalone_instance`), used to point the bridge (or a
    wrong-config-dir probe) at a specific pair of shared-instance ports without the
    dir needing its own [interfaces] section."""
    configdir.mkdir(parents=True, exist_ok=True)
    body = _RETICULUM_SECTION.format(
        share_instance="Yes", rpc_port=rpc_port, rpc_ctrl_port=rpc_ctrl_port
    )
    (configdir / "config").write_text(body)


def write_announcer_config(configdir: Path, target_port: int) -> None:
    """A standalone (non-shared) config for the announcer subprocess: its own
    TCPClientInterface dialing instance A's TCPServerInterface."""
    configdir.mkdir(parents=True, exist_ok=True)
    body = "[reticulum]\n  enable_transport = No\n  share_instance = No\n\n[logging]\n  loglevel = 3\n"
    body += _CLIENT_INTERFACES_SECTION.format(target_port=target_port)
    (configdir / "config").write_text(body)


def spawn_announcer(configdir: Path, app_data: bytes = b"WP2-integration-test", timeout: float = 15.0) -> None:
    script = Path(__file__).parent / "_announcer.py"
    proc = subprocess.run(
        [PYTHON, str(script), str(configdir), app_data.decode("utf-8", "replace")],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"announcer subprocess failed:\n{proc.stdout}\n{proc.stderr}")


@dataclass
class BridgeProcess:
    """A real `python -m meshmonitor_rns_bridge` subprocess."""

    env: dict
    process: Optional[subprocess.Popen] = None
    _capture: Optional[_OutputCapture] = field(default=None, repr=False)

    def start(self, ws_port: int, timeout: float = 10.0) -> None:
        full_env = dict(os.environ)
        full_env.update(self.env)
        self.process = subprocess.Popen(
            [PYTHON, "-m", "meshmonitor_rns_bridge"],
            cwd=str(BRIDGE_ROOT),
            env=full_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self._capture = _OutputCapture(self.process.stdout)
        wait_for_port("127.0.0.1", ws_port, timeout)

    def poll(self) -> Optional[int]:
        return None if self.process is None else self.process.poll()

    def wait_exit(self, timeout: float = 10.0) -> int:
        assert self.process is not None
        return self.process.wait(timeout=timeout)

    def stop(self, timeout: float = 5.0) -> None:
        if self.process is None or self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=timeout)

    def output(self) -> str:
        return self._capture.text() if self._capture else ""
