"""Threaded WebSocket server (build spec §4.1/§4.2): `websockets.sync.server`, no
asyncio anywhere. Handshake, token auth, and message dispatch for the single Node
client that talks to this bridge.

Threading model: `websockets.sync.server.serve()` spawns one thread per connection
running `_handle_connection`. Within that thread we spawn one more (`_writer_loop`)
that drains this connection's subscriber queue and writes to the socket, so an RNS
announce/poller thread (which calls `manager.broadcast()`) never blocks on socket I/O.
"""

from __future__ import annotations

import logging
import queue
import threading
from typing import Optional

import RNS
from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve as ws_serve

from . import protocol
from .config import TcpPeer
from .rns_manager import RNSManager, RNSStartupError

logger = logging.getLogger("meshmonitor_rns_bridge.ws_server")

HELLO_TIMEOUT_S = 10.0
WRITER_POLL_S = 1.0


def _safe_send(websocket, env: dict) -> bool:
    try:
        websocket.send(protocol.encode(env))
        return True
    except ConnectionClosed:
        return False


def _writer_loop(websocket, q: "queue.Queue", stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            event = q.get(timeout=WRITER_POLL_S)
        except queue.Empty:
            continue
        if not _safe_send(websocket, event):
            return


def _parse_peers(raw_peers) -> Optional[list]:
    """Parses the `configure` message's `peers` field (build spec §4.4:
    `{host:string; port:number}[]`) into TcpPeer instances -- the same type
    rns_manager.py's _start_tcp_peer() expects from the env-derived BridgeConfig, so
    both sources feed it identically."""
    if not raw_peers:
        return None
    peers = []
    for p in raw_peers:
        try:
            peers.append(TcpPeer(host=p["host"], port=int(p["port"])))
        except (KeyError, TypeError, ValueError):
            logger.warning("ignoring malformed peer entry in configure message: %r", p)
    return peers


def _handle_configure(websocket, manager: RNSManager, req: dict) -> "queue.Queue | None":
    """Handles a `configure` message. Returns a freshly-subscribed queue.Queue if
    this call started (or found already-started) the manager, else None."""
    mode = req.get("mode")
    config_dir = req.get("configDir")
    peers = _parse_peers(req.get("peers"))
    req_id = req.get("id")

    try:
        # request_start(), not start(): this runs on a WS connection-handler thread,
        # but RNS.Reticulum() must be constructed on the process's main thread (it
        # registers SIGINT/SIGTERM handlers, which Python restricts to the main
        # thread). request_start() hands off to RNSManager.run_dispatcher(), which
        # __main__.py runs on the main thread, and blocks here for the result.
        manager.request_start(mode=mode, rns_config_dir=config_dir, tcp_peers=peers)
    except RNSStartupError as e:
        _safe_send(websocket, protocol.error_message(e.code, e.message, id=req_id))
        return None

    _safe_send(websocket, protocol.ready_message(id=req_id))
    return manager.subscribe()


def _handle_connection(websocket, manager: RNSManager, cfg, bridge_version: str) -> None:
    peer = getattr(websocket, "remote_address", None)
    logger.info("connection opened from %s", peer)

    try:
        raw = websocket.recv(timeout=HELLO_TIMEOUT_S)
    except (TimeoutError, ConnectionClosed):
        logger.warning("connection from %s closed before hello", peer)
        return

    try:
        hello = protocol.decode(raw)
    except protocol.ProtocolError as e:
        _safe_send(websocket, protocol.error_message(protocol.AUTH_FAILED, f"malformed hello: {e}"))
        return

    if hello.get("type") != protocol.TYPE_HELLO:
        _safe_send(websocket, protocol.error_message(protocol.AUTH_FAILED, "expected 'hello' as first message"))
        return

    if hello.get("protocolVersion") != protocol.PROTOCOL_VERSION:
        _safe_send(
            websocket,
            protocol.error_message(
                protocol.PROTOCOL_VERSION_MISMATCH,
                f"bridge speaks protocol {protocol.PROTOCOL_VERSION}, "
                f"client sent {hello.get('protocolVersion')!r}",
            ),
        )
        return

    if hello.get("token") != cfg.token:
        _safe_send(websocket, protocol.error_message(protocol.AUTH_FAILED, "invalid token"))
        return

    rns_version = getattr(RNS, "__version__", "unknown")
    _safe_send(websocket, protocol.welcome_message(bridge_version, rns_version))

    sub_queue: "queue.Queue | None" = None
    writer_stop = threading.Event()
    writer_thread: "threading.Thread | None" = None

    try:
        while True:
            try:
                raw = websocket.recv(timeout=None)
            except ConnectionClosed:
                break

            try:
                req = protocol.decode(raw)
            except protocol.ProtocolError:
                logger.warning("ignoring malformed message from %s", peer)
                continue

            req_type = req.get("type")

            if req_type == protocol.TYPE_CONFIGURE:
                if sub_queue is None:
                    sub_queue = _handle_configure(websocket, manager, req)
                    if sub_queue is not None:
                        writer_thread = threading.Thread(
                            target=_writer_loop,
                            args=(websocket, sub_queue, writer_stop),
                            daemon=True,
                            name="ws-writer",
                        )
                        writer_thread.start()
                else:
                    # Already configured this session -- re-send ready/current status
                    # rather than re-running start() (idempotent anyway, but this
                    # avoids a second subscribe()).
                    _safe_send(websocket, protocol.ready_message(id=req.get("id")))

            elif req_type == protocol.TYPE_GET_STATUS:
                _safe_send(websocket, protocol.status_message(id=req.get("id"), **manager.status()))

            else:
                logger.debug("ignoring unknown message type %r from %s", req_type, peer)
    finally:
        writer_stop.set()
        if sub_queue is not None:
            manager.unsubscribe(sub_queue)
        logger.info("connection closed from %s", peer)


def serve(cfg, manager: RNSManager, bridge_version: str, stop_event: threading.Event):
    """Starts the WS server and blocks until `stop_event` is set (from the health
    monitor or a signal handler in __main__.py). Returns the `Server` object's exit."""

    def handler(websocket):
        try:
            _handle_connection(websocket, manager, cfg, bridge_version)
        except Exception:
            logger.exception("unhandled error in connection handler")

    with ws_serve(handler, cfg.host, cfg.port) as server:
        logger.info("listening on %s:%d", cfg.host, cfg.port)
        watcher = threading.Thread(
            target=lambda: (stop_event.wait(), server.shutdown()),
            daemon=True,
            name="ws-shutdown-watcher",
        )
        watcher.start()
        server.serve_forever()
