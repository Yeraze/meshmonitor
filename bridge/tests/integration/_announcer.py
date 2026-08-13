"""Standalone helper: creates an RNS identity + destination in its own config dir and
sends ONE announce, then exits.

Deliberately run as its own OS process (spawned via subprocess, never imported) so its
`RNS.Reticulum()` call never shares a process with pytest or any other
`RNS.Reticulum()` call. RNS.Reticulum is a process-wide singleton (WP0 spike evidence
§6.4): a second construction in the same process raises an unrelated
'Attempt to reinitialise Reticulum' OSError that would mask real test failures.

Usage: python _announcer.py <configdir> [app_data_utf8]
"""

from __future__ import annotations

import sys
import time

import RNS


def main() -> int:
    configdir = sys.argv[1]
    app_data = sys.argv[2].encode("utf-8") if len(sys.argv) > 2 else b""

    RNS.Reticulum(configdir=configdir)
    identity = RNS.Identity()
    destination = RNS.Destination(
        identity, RNS.Destination.IN, RNS.Destination.SINGLE, "meshmonitor", "wp2test"
    )
    destination.announce(app_data=app_data)

    # Give the Transport background thread time to actually flush the announce packet
    # over the TCPClientInterface socket before this process (and its interface) tears
    # down -- destination.announce() only enqueues, it doesn't block until sent.
    time.sleep(2.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
