"""Shared fixture loading for the BYOC Python conformance suite.

Loads the same JSON vectors under ``/spec/fixtures`` that the TypeScript SDK
runs against. A failure here means this implementation has drifted from the
cross-SDK contract.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "spec" / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    """Load a conformance fixture by filename."""
    with (FIXTURE_DIR / name).open(encoding="utf-8") as handle:
        data: dict[str, Any] = json.load(handle)
    return data
