#!/usr/bin/env python3
"""A/B ear-gate for colour-axis orthogonalization (OWNER-RUN — needs SA3 weights).

Renders the same source beat through the two measured "offender" same-layer stacks
BOTH ways — current backoff vs orthogonalized — plus each axis SOLO, and writes an
`index.html` you listen to. Same source + seed + nl, so the ONLY difference in each
A/B pair is `resolve_steers(orthogonalize=…)`. The verdict is your ear: does the
orthogonalized stack compose cleaner WITHOUT the axes losing their identity (compare
each stacked axis to its solo). Only if it wins does orthogonalization earn a default.

Run (MLX + SA3 weights present):
    MOSH_ENABLE_SA3=1 python3 service/colors/ab_ortho_render.py \
        --source /path/to/beat.wav --out ~/mosh-ortho-ab
Then open <out>/index.html.
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # service/ on the path

# The two measured offenders (same peak_layer, correlated) + the four solos to A/B against.
STACKS = [
    ("ft", "futuristic + tension  (L4, 51.3°)",
     [{"name": "futuristic", "value": 100}, {"name": "tension", "value": 100}]),
    ("de", "distortion + epic  (L17, 67.7°)",
     [{"name": "distortion", "value": 100}, {"name": "epic", "value": 100}]),
]
SOLOS = ["futuristic", "tension", "distortion", "epic"]


def _render(eng, init_cache, CR, source, seed, nl, colors, orthogonalize, out_wav):
    steers = CR.resolve_steers(colors, orthogonalize=orthogonalize)
    init_lat, _ = init_cache.get_or_encode(eng, source)
    eng.reimagine("", seed, init_lat, init_noise_level=nl, steers=steers, out_wav=out_wav)
    return steers


def _html(rows_html: str, source_name: str, seed: int, nl: float) -> str:
    return f"""<!doctype html><meta charset="utf-8"><title>colour orthogonalization — A/B</title>
<style>
 body{{font-family:-apple-system,sans-serif;margin:2rem auto;max-width:1000px;background:#141210;color:#e8e2d8;}}
 h1{{font-weight:800;}} h3{{color:#f2b64a;margin-top:1.6rem;}}
 .row{{display:flex;gap:1rem;align-items:center;padding:.6rem .4rem;border-bottom:1px solid #2a2622;flex-wrap:wrap;}}
 .prompt{{flex:1 1 100%;font-size:.9rem;color:#b9b0a2;}}
 .cell{{background:#1e1b17;padding:.5rem .8rem;border-radius:10px;}} .lbl{{font-size:.75rem;margin-bottom:.25rem;color:#8f8678;}}
 audio{{width:460px;}} code{{color:#f2b64a;}}
</style>
<h1>🎨 Colour-axis orthogonalization — A/B ear gate</h1>
<p class="prompt">Source <code>{source_name}</code>, seed {seed}, noise {nl}. Each A/B pair differs ONLY by
<code>resolve_steers(orthogonalize=…)</code>: <b>backoff</b> = today's a2/a3 magnitude clamp on the raw
(correlated) vecs; <b>ortho</b> = same alphas, but the same-layer vecs de-correlated (Löwdin, norm-preserved).
Listen for: does <b>ortho</b> compose cleaner (each axis audible, less mud) WITHOUT the axes losing their
identity vs. their <b>solo</b> renders below?</p>
{rows_html}
"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="a beat WAV to re-imagine")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-ortho-ab"))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--nl", type=float, default=0.4)
    args = ap.parse_args()

    from sa3 import engine as E
    if not E.engine_available():
        print("SA3 engine unavailable — this harness needs the MLX SA3 weights.\n"
              "Set MOSH_ENABLE_SA3=1 and ensure SA3_MLX_DIR points at the weights, then re-run.",
              file=sys.stderr)
        return 2
    if not os.path.exists(args.source):
        print(f"--source not found: {args.source}", file=sys.stderr)
        return 2

    from sa3 import init_cache
    from colors import runtime as CR
    os.makedirs(args.out, exist_ok=True)
    eng = E.get_engine()
    src = os.path.abspath(args.source)

    rows = []
    for key, label, colors in STACKS:
        pair_html = [f'<h3>{label}</h3><div class="row">']
        for variant, ortho_on in (("backoff", False), ("ortho", True)):
            out_wav = os.path.join(args.out, f"{key}_{variant}.wav")
            st = _render(eng, init_cache, CR, src, args.seed, args.nl, colors, ortho_on, out_wav)
            print(f"[{key}/{variant}] steers={[(l, round(a, 3)) for l, a, _ in st]} -> {out_wav}")
            pair_html.append(
                f'<div class="cell"><div class="lbl">{variant}</div>'
                f'<audio controls preload="none" src="{key}_{variant}.wav"></audio></div>')
        pair_html.append("</div>")
        rows.append("".join(pair_html))

    solo_html = ['<h3>solos (each axis alone — the identity reference; ortho is a no-op here)</h3><div class="row">']
    for name in SOLOS:
        out_wav = os.path.join(args.out, f"solo_{name}.wav")
        _render(eng, init_cache, CR, src, args.seed, args.nl, [{"name": name, "value": 100}], False, out_wav)
        print(f"[solo/{name}] -> {out_wav}")
        solo_html.append(
            f'<div class="cell"><div class="lbl">{name}</div>'
            f'<audio controls preload="none" src="solo_{name}.wav"></audio></div>')
    solo_html.append("</div>")
    rows.append("".join(solo_html))

    index = os.path.join(args.out, "index.html")
    with open(index, "w") as f:
        f.write(_html("\n".join(rows), os.path.basename(src), args.seed, args.nl))
    print(f"\nWrote {index} — open it and judge by ear.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
