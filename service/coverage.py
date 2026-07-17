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


def window_order(n, playhead_s, window_s):
    """Streaming lookahead: render order for n stitch windows given the playhead
    position INSIDE the clip. Starts at the window AFTER the one under the playhead
    ("the next 4/8 bars, whatever's coming up") and wraps, so fresh audio rolls out
    ahead of the listener. No/invalid playhead → natural order (deterministic)."""
    if n <= 1 or playhead_s is None or playhead_s < 0 or window_s <= 0:
        return list(range(n))
    k = int(playhead_s // window_s) + 1
    return [(k + j) % n for j in range(n)]


def render(render_window, input_wav, output_wav, params, window_max_s):
    """render_window(in_wav, out_wav, params) -> manifest renders ONE window (<= window_max_s).
    Returns that manifest with coverage + the full output duration stamped in."""
    dur = stitch.wav_duration(input_wav) if (input_wav and os.path.exists(input_wav)) else 0.0
    target_s = float(params.get("duration_s") or dur or 0.0)
    coverage = (params.get("coverage") or "auto")
    loop_s = float(params.get("loop_seconds") or 0.0) or min(window_max_s, target_s or window_max_s)
    xfade_ms = float(params.get("xfade_ms") or 8.0)

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
        # Streaming lookahead (progressive): windows render in playhead-ahead order and
        # each completed window snapshots a FULL-LENGTH artifact (fresh audio where
        # rendered, the original elsewhere) as `<output>.progressive.<seq>.wav` — the
        # native side lands each at a musical boundary while later windows still render.
        # Per-window renders depend only on their own slice + params, so the FINAL
        # stitched output is byte-identical to the non-progressive path.
        n = max(1, math.ceil(target_s / window_max_s))
        progressive = bool(params.get("progressive")) and n >= 2 \
            and input_wav and os.path.exists(input_wav)
        ph = params.get("playhead_s") if progressive else None
        order = window_order(n, float(ph) if ph is not None else None, window_max_s)

        base = base_ch = base_sr = base_sw = None
        if progressive:
            try:
                base, base_ch, base_sr, base_sw = stitch._read(input_wav)
            except Exception:  # noqa: BLE001 — odd input depth → plain stitch, no artifacts
                progressive = False

        wouts, last, prog_seq = [None] * n, None, 0
        for i in order:
            wi = os.path.join(tmp, f"w{i}_in.wav")
            wo = os.path.join(tmp, f"w{i}_out.wav")
            stitch.slice_wav(input_wav, wi, i * window_max_s, window_max_s)
            last = render_window(wi, wo, params)
            wouts[i] = wo
            if progressive:
                try:
                    seg, seg_ch, seg_sr, _sw = stitch._read(wo)
                    if seg_ch == base_ch and seg_sr == base_sr:
                        stitch.overlay_window(base, base_ch, seg,
                                              int(round(i * window_max_s * base_sr)),
                                              int(round(window_max_s * base_sr)),
                                              int(round(xfade_ms / 1000.0 * base_sr)))
                        prog_seq += 1
                        ptmp = output_wav + f".progressive.{prog_seq}.tmp"
                        stitch._write(ptmp, base, base_ch, base_sr, base_sw)
                        os.replace(ptmp, output_wav + f".progressive.{prog_seq}.wav")
                except Exception:  # noqa: BLE001 — a failed snapshot never fails the render
                    pass
        stitch.stitch_windows(wouts, output_wav, target_s, xfade_ms)
        m = dict(last or {})
        m["coverage"] = "stitch"
        m["duration_s"] = round(target_s, 3)
        if prog_seq:
            m["progressive"] = prog_seq
        return m
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
