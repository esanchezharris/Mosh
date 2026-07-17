"""Whole-clip coverage orchestration (05): cover a clip LONGER than a model's single render
window by tiling one cycle (loops/beats) or stitching consecutive windows (through-composed).

Adapters pass their per-window render callback + their max single-render window. The fake and
transform adapters have effectively no cap (WINDOW_UNCAPPED); SA3 caps at its loaded SA3_SECONDS.
The native side resolves `coverage` ("loop"|"stitch") and supplies `duration_s` (the whole-clip
length) and `loop_seconds` (one cycle); deterministic, so golden checksums stay stable.
"""
from __future__ import annotations

import math
import os
import shutil
import tempfile

import stitch

WINDOW_UNCAPPED = 1.0e9   # adapters with no single-render length limit (fake / transform)


def render(render_window, input_wav, output_wav, params, window_max_s):
    """render_window(in_wav, out_wav, params) -> manifest renders ONE window (<= window_max_s).
    Returns that manifest with coverage + the full output duration stamped in."""
    dur = stitch.wav_duration(input_wav) if (input_wav and os.path.exists(input_wav)) else 0.0
    target_s = float(params.get("duration_s") or dur or 0.0)
    coverage = (params.get("coverage") or "auto")
    loop_s = float(params.get("loop_seconds") or 0.0) or min(window_max_s, target_s or window_max_s)
    xfade_ms = float(params.get("xfade_ms") or 1.0)  # owner-tuned: 1ms is the sweet spot (declick without smear)

    fits = dur <= window_max_s + 1.0e-3
    # No source / no target, or it fits in one window and isn't an explicit loop → render directly.
    if target_s <= 0.0 or (fits and coverage != "loop"):
        m = render_window(input_wav, output_wav, params)
        m.setdefault("coverage", "single")
        return m

    tmp = tempfile.mkdtemp(prefix="mosh-cov-")
    try:
        if coverage == "loop":
            cyc_s = min(loop_s, window_max_s)
            cin = os.path.join(tmp, "cyc_in.wav")
            cout = os.path.join(tmp, "cyc_out.wav")
            stitch.slice_wav(input_wav, cin, 0.0, cyc_s)
            m = render_window(cin, cout, params)
            stitch.tile_to_length(cout, output_wav, target_s, xfade_ms)
            m["coverage"] = "loop"
            m["duration_s"] = round(target_s, 3)
            return m

        # stitch: render consecutive windows across the input, crossfade them together.
        n = max(1, math.ceil(target_s / window_max_s))
        wouts, last = [], None
        for i in range(n):
            wi = os.path.join(tmp, f"w{i}_in.wav")
            wo = os.path.join(tmp, f"w{i}_out.wav")
            stitch.slice_wav(input_wav, wi, i * window_max_s, window_max_s)
            last = render_window(wi, wo, params)
            wouts.append(wo)
        stitch.stitch_windows(wouts, output_wav, target_s, xfade_ms)
        m = dict(last or {})
        m["coverage"] = "stitch"
        m["duration_s"] = round(target_s, 3)
        return m
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
