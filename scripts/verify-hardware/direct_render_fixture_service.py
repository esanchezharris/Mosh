#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# ─── How to run ───
# Only launched by verify-direct-reimagine.py in an isolated native test session.
# No model, downloaded assets or owner session is used.
"""Wire-level deterministic faults for the real native Re-Imagine client."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import TypeAlias

Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
import server  # noqa: E402


class FixtureRenderFailure(RuntimeError):
    pass


def fixture_render(source: str, output: str, params: dict[str, Json]) -> dict[str, Json]:
    """Exercise the protocol with visibly identified fixture audio and faults."""
    marker = Path(os.environ["MOSH_TEST_DIRECT_MARKER"])
    marker.write_text(str(os.getpid()))
    (marker.parent / f"request-{params['request_id']}.json").write_text(json.dumps(params))
    mode = os.environ.get("MOSH_TEST_DIRECT_MODE", "normal")
    if mode == "delayed":
        threading.Event().wait(3.0)
    if mode == "failed":
        raise FixtureRenderFailure("Deliberate deterministic fixture failure")
    result = original_render(source, output, params)
    if mode == "malformed":
        Path(output).write_bytes(b"Deliberate invalid fixture audio")
    return result


original_render = server.fake_adapter.render
server.fake_adapter.render = fixture_render

if __name__ == "__main__":
    if os.environ.get("MOSH_DIRECT_RENDER_TEST_FIXTURE") != "1" or not os.environ.get("MOSH_SELFTEST_SESSION", "").startswith("_harness/"):
        raise SystemExit("Fixture service requires an isolated native harness")
    raise SystemExit(server.main())
