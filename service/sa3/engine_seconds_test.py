"""Golden test for the contiguous-render length clamp (service/sa3/engine.py).

Hermetic + stdlib-only: engine.py's module top imports no mlx (that's lazy in __init__),
so the pure `clamp_render_seconds` helper + MIN/MAX constants import without a GPU/model.
This pins the "render at the clip's own length, capped at the contiguous ceiling" policy
that the contiguous-first path relies on. Run via gate.sh run_py_tests (named *_test.py).
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
from sa3 import engine


def main():
    MIN, MAX = engine.MIN_SECONDS, engine.MAX_CONTIGUOUS
    assert 0 < MIN < MAX, f"sane bounds ({MIN}..{MAX})"

    # a clip within range renders at its OWN length (contiguous, one pass)
    assert engine.clamp_render_seconds(52.2) == 52.2, "in-range clip renders at its length"
    assert engine.clamp_render_seconds(120.0) == 120.0, "2min clip renders at its length"

    # longer than the ceiling → capped (the stitch fallback then covers the rest)
    assert engine.clamp_render_seconds(MAX + 100) == MAX, "over ceiling → capped at MAX"

    # shorter than the floor → floored (avoid a degenerate tiny latent grid)
    assert engine.clamp_render_seconds(MIN / 2.0) == MIN, "sub-floor → floored at MIN"
    assert engine.clamp_render_seconds(0.0) == MIN, "zero → floored"

    # exact-boundary + type
    assert engine.clamp_render_seconds(MAX) == MAX
    assert isinstance(engine.clamp_render_seconds(30), float)

    # deterministic
    assert engine.clamp_render_seconds(45.3) == engine.clamp_render_seconds(45.3)

    original_path = os.environ.get("PATH")
    try:
        with tempfile.TemporaryDirectory(prefix="mosh-ffmpeg-path-") as temp_dir:
            executable = Path(temp_dir) / "ffmpeg"
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o755)
            os.environ["PATH"] = "/usr/bin:/bin"
            resolved = engine._ensure_command_on_path("ffmpeg", (temp_dir,))
            assert resolved == str(executable), "fallback executable is discovered"
            assert os.environ["PATH"].split(os.pathsep)[0] == temp_dir, "fallback dir is published to subprocesses"
    finally:
        if original_path is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = original_path

    print("engine_seconds_test: OK (render length clamp + restricted-PATH command discovery)")


if __name__ == "__main__":
    main()
