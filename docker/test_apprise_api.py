#!/usr/bin/env python3
"""
Regression test for #5184: a client that gives up on a request (e.g. Node's
fetch() aborting via AbortSignal.timeout) before apprise-api.py finishes
writing its response must not produce an unhandled BrokenPipeError traceback.

Run directly:  python3 docker/test_apprise_api.py
Requires the `apprise` package (already a runtime dependency of apprise-api.py).
"""
import importlib.util
import io
import os
import socket
import sys
import threading
import time
import unittest
from http.server import HTTPServer

MODULE_PATH = os.path.join(os.path.dirname(__file__), 'apprise-api.py')


def _load_apprise_api_module():
    spec = importlib.util.spec_from_file_location('apprise_api_module', MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class ClientDisconnectTest(unittest.TestCase):
    def setUp(self):
        self.mod = _load_apprise_api_module()
        self.server = HTTPServer(('127.0.0.1', 0), self.mod.AppriseHandler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        time.sleep(0.1)

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)

    def _post_and_disconnect(self, path, body: bytes):
        """Send a POST request, then close the socket before reading any
        response — simulating a fetch() call whose AbortSignal.timeout fired."""
        req = (
            f"POST {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{self.port}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n\r\n"
        ).encode() + body
        sock = socket.create_connection(('127.0.0.1', self.port))
        sock.sendall(req)
        sock.shutdown(socket.SHUT_RDWR)
        sock.close()

    def test_disconnect_before_response_does_not_crash_server(self):
        captured = io.StringIO()
        orig_stderr = sys.stderr
        sys.stderr = captured
        try:
            # No URLs configured -> handler will try to write a 400 response
            # to a socket the "client" already closed.
            self._post_and_disconnect('/notify', b'{"title":"t","body":"b"}')
            time.sleep(0.3)
        finally:
            sys.stderr = orig_stderr

        output = captured.getvalue()
        self.assertNotIn('Traceback', output, f"Unhandled exception logged:\n{output}")
        self.assertNotIn('BrokenPipeError', output, f"Unhandled exception logged:\n{output}")

        # Server must still be alive and able to serve a normal request.
        conn = socket.create_connection(('127.0.0.1', self.port))
        conn.sendall(b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        resp = conn.recv(4096)
        conn.close()
        self.assertIn(b"200", resp)


if __name__ == '__main__':
    unittest.main()
