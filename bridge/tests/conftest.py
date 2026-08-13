"""pytest bootstrap: put `bridge/` (the parent of this tests/ dir) on sys.path so
`import meshmonitor_rns_bridge` resolves regardless of invocation cwd (`pytest
bridge/tests` from the repo root, or `pytest tests` from inside `bridge/`), since this
package has no setup.py/pyproject.toml install step (build spec §4.1 layout)."""

from __future__ import annotations

import os
import sys

BRIDGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BRIDGE_ROOT not in sys.path:
    sys.path.insert(0, BRIDGE_ROOT)

import json
import pathlib

import pytest

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


@pytest.fixture
def load_fixture():
    def _load(name: str) -> dict:
        with open(FIXTURES_DIR / f"{name}.json") as f:
            return json.load(f)

    return _load
