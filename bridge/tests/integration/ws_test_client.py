"""Minimal reference WS client used only by tests, exercising the same wire protocol
a real Node `reticulumBridgeClient.ts` (WP3) would use."""

from __future__ import annotations

import time
from typing import Callable, Optional

from websockets.sync.client import connect as ws_connect

from meshmonitor_rns_bridge import protocol


class BridgeClient:
    def __init__(self, uri: str, token: str):
        self.uri = uri
        self.token = token
        self.ws = None

    def __enter__(self) -> "BridgeClient":
        self.ws = ws_connect(self.uri, open_timeout=10)
        return self

    def __exit__(self, *exc) -> None:
        if self.ws is not None:
            self.ws.close()

    def hello(self, protocol_version: int = protocol.PROTOCOL_VERSION) -> dict:
        self.ws.send(protocol.encode(protocol.hello_message(self.token, protocol_version)))
        return self.recv()

    def configure(
        self,
        mode: str,
        config_dir: Optional[str] = None,
        peers: Optional[list] = None,
        id: str = "c0",
    ) -> dict:
        self.ws.send(protocol.encode(protocol.configure_message(mode, id=id, config_dir=config_dir, peers=peers)))
        return self.recv()

    def get_status(self, id: str = "s0") -> dict:
        self.ws.send(protocol.encode(protocol.get_status_message(id)))
        return self.recv_until(lambda e: e.get("type") == protocol.TYPE_STATUS and e.get("id") == id)

    def recv(self, timeout: float = 10.0) -> dict:
        raw = self.ws.recv(timeout=timeout)
        return protocol.decode(raw)

    def recv_until(self, predicate: Callable[[dict], bool], timeout: float = 15.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("no matching message received in time")
            raw = self.ws.recv(timeout=remaining)
            env = protocol.decode(raw)
            if predicate(env):
                return env
