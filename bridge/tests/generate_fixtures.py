"""Regenerate bridge/tests/fixtures/*.json from the live protocol.py builders
(via fixture_builders.py -- the single source of truth both this script and
test_protocol.py read from).

Run this after changing any message-builder function in
meshmonitor_rns_bridge/protocol.py (or its argument list in
fixture_builders.py), then check the diff:

    python bridge/tests/generate_fixtures.py
    git diff bridge/tests/fixtures

If the diff is non-empty, the checked-in fixtures were stale -- commit the
regenerated files together with the protocol.py change that caused the drift.
test_protocol.py's test_fixture_matches_live_builder_output makes the same
comparison inside pytest (so `pytest bridge/tests` fails loudly on drift too);
this script is the fix-it counterpart that writes the corrected JSON instead
of just reporting the mismatch. CI
(`.github/workflows/reticulum-bridge.yml`) runs both this script and `git
diff --exit-code` as an explicit contract-drift guard, on top of the pytest
assertion, so a stale fixture can't slip in even if someone edits
fixtures/*.json by hand without also updating protocol.py.

Invocation: works both as a standalone script (`python
bridge/tests/generate_fixtures.py` from anywhere) and as a package module
(`python -m tests.generate_fixtures`, run with cwd=bridge/).
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

BRIDGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BRIDGE_ROOT not in sys.path:
    sys.path.insert(0, BRIDGE_ROOT)

from meshmonitor_rns_bridge import protocol  # noqa: E402  (path bootstrap above)

TESTS_DIR = pathlib.Path(__file__).resolve().parent
FIXTURES_DIR = TESTS_DIR / "fixtures"

try:
    from .fixture_builders import EXPECTED_FIXTURE_NAMES, FIXED_TS, NON_PROTOCOL_FIXTURE_STEMS, build_fixture
except ImportError:
    # Executed as a bare script (no package context for a relative import).
    sys.path.insert(0, str(TESTS_DIR))
    from fixture_builders import (  # type: ignore[no-redef]
        EXPECTED_FIXTURE_NAMES,
        FIXED_TS,
        NON_PROTOCOL_FIXTURE_STEMS,
        build_fixture,
    )


def main() -> None:
    protocol.now_ms = lambda: FIXED_TS  # freeze ts for byte-stable output, mirrors
    # test_protocol.py's `frozen_now` fixture.

    FIXTURES_DIR.mkdir(exist_ok=True)

    written = []
    for name in sorted(EXPECTED_FIXTURE_NAMES):
        env = build_fixture(name)
        text = json.dumps(env, indent=2, sort_keys=True) + "\n"
        path = FIXTURES_DIR / f"{name}.json"
        path.write_text(text)
        written.append(path.name)
        print(f"wrote {path.relative_to(BRIDGE_ROOT)}")

    # Prune any fixture file that no longer has a builder, kept in sync with
    # test_protocol.py's test_fixture_directory_has_exactly_the_expected_files.
    # NON_PROTOCOL_FIXTURE_STEMS (#3960 Phase 3 WP0/WP2) are deliberately not
    # written above (no build_fixture() entry) but must survive pruning too --
    # e.g. the Sideband FIELD_TELEMETRY golden-decode fixture.
    for path in FIXTURES_DIR.glob("*.json"):
        if path.name not in written and path.stem not in NON_PROTOCOL_FIXTURE_STEMS:
            path.unlink()
            print(f"removed stale {path.relative_to(BRIDGE_ROOT)}")


if __name__ == "__main__":
    main()
