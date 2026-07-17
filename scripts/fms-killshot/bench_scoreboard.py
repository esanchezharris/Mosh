#!/usr/bin/env python3
"""Render the FMS-Bench mumble-ratio scoreboard as a self-contained HTML page.

Merges per-run stats (from one or more bench_run out dirs), builds generator × ratio curves,
and emits inline-SVG line charts (metric vs mumble-ratio) plus per-item audio players
(clean / mumbled@ρ / generated). No external deps; served by preview_server.

Usage:  bench_scoreboard.py OUT_DIR [OUT_DIR ...] --html PAGE.html [--root SERVE_ROOT]
"""
from __future__ import annotations

import argparse
import glob
import html
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_run as br  # noqa: E402

# metric key → (label, axis, "hi"|"lo" so we can tint good/bad direction)
CHARTS = [
    ("bag_coverage", "word bag-coverage", "correctness", "hi"),
    ("seq_ratio", "word sequence-match", "correctness", "hi"),
    ("f1", "onset F1 (timing)", "correctness", "hi"),
    ("abs_median_st", "F0 error (semitones)", "correctness", "lo"),
    ("pq", "naturalness (pq)", "naturalness", "hi"),
]
COLORS = {"oracle": "#22c55e", "passthrough": "#ef4444", "pipeline": "#3b82f6"}


def load_runs(dirs):
    runs = []
    for d in dirs:
        for jf in glob.glob(os.path.join(d, "**", "scoreboard.json"), recursive=True) or \
                [os.path.join(d, "scoreboard.json")]:
            if os.path.isfile(jf):
                runs.extend(json.load(open(jf)).get("runs", []))
    return runs


def _svg_chart(label, ratios_all, board, key, axis, direction, w=380, h=220):
    pad = 42
    xs = sorted(ratios_all)
    ys = []
    for gen, gd in board.items():
        for v in gd.get(axis, {}).get(key, []):
            if v is not None:
                ys.append(v)
    if not ys:
        return f'<div class="chart"><h4>{html.escape(label)}</h4><p class="muted">no data</p></div>'
    ymin, ymax = min(ys + [0.0]), max(ys)
    if ymax == ymin:
        ymax = ymin + 1.0
    xmin, xmax = min(xs), max(xs)
    xr = (xmax - xmin) or 1.0

    def px(r):
        return pad + (r - xmin) / xr * (w - 2 * pad)

    def py(v):
        return h - pad - (v - ymin) / (ymax - ymin) * (h - 2 * pad)

    out = [f'<svg viewBox="0 0 {w} {h}" class="svg">']
    out.append(f'<line x1="{pad}" y1="{h-pad}" x2="{w-pad}" y2="{h-pad}" class="ax"/>')
    out.append(f'<line x1="{pad}" y1="{pad}" x2="{pad}" y2="{h-pad}" class="ax"/>')
    out.append(f'<text x="{pad}" y="{py(ymax)-4:.0f}" class="tick">{ymax:.2f}</text>')
    out.append(f'<text x="{pad}" y="{h-pad+4:.0f}" class="tick">{ymin:.2f}</text>')
    for r in xs:
        out.append(f'<text x="{px(r):.0f}" y="{h-pad+16:.0f}" class="tick" text-anchor="middle">{r:g}</text>')
    for gen, gd in board.items():
        vals = gd.get(axis, {}).get(key, [])
        rr = gd.get("ratios", [])
        pts = [(px(r), py(v)) for r, v in zip(rr, vals) if v is not None]
        if not pts:
            continue
        col = COLORS.get(gen, "#888")
        d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        out.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2"/>')
        for x, y in pts:
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="{col}"/>')
    out.append("</svg>")
    arrow = "↑ higher = better" if direction == "hi" else "↓ lower = better"
    return f'<div class="chart"><h4>{html.escape(label)} <span class="muted">{arrow}</span></h4>{"".join(out)}</div>'


def _rel(path, root):
    try:
        return os.path.relpath(path, root)
    except ValueError:
        return path


def render_html(runs, out_html, root):
    board = br.build_scoreboard(runs)
    ratios_all = sorted({r["ratio"] for r in runs})
    items = sorted({r["item"] for r in runs})
    gens = sorted(board)
    charts = "".join(_svg_chart(lbl, ratios_all, board, key, axis, dr) for key, lbl, axis, dr in CHARTS)

    legend = " ".join(f'<span class="dot" style="background:{COLORS.get(g,"#888")}"></span>{html.escape(g)}'
                      for g in gens)

    # per-item audio: clean + mumbled@each ρ (passthrough) + oracle/pipeline generated
    rows = []
    by_item = {}
    for r in runs:
        by_item.setdefault(r["item"], []).append(r)
    for it in items:
        irs = by_item[it]
        clean = None
        # find the clean vocal via any run's stats meta (reference basename) — use mumbled's sibling
        players = []
        seen = set()
        for r in sorted(irs, key=lambda r: (r["ratio"], r["generator"])):
            mp = _rel(r["mumbled"], root)
            if mp not in seen:
                seen.add(mp)
                players.append(f'<div class="pl"><span>mumble ρ={r["ratio"]:g}</span>'
                               f'<audio controls preload="none" src="{html.escape(mp)}"></audio></div>')
        rows.append(f'<div class="item"><h3>{html.escape(it)}</h3><div class="players">{"".join(players)}</div></div>')

    doc = f"""<!doctype html><meta charset="utf-8"><title>FMS-Bench scoreboard</title>
<style>
 body{{font:14px/1.5 -apple-system,system-ui,sans-serif;background:#0b0e14;color:#e6edf3;margin:0;padding:24px;max-width:1100px}}
 h1{{font-size:20px}} h2{{font-size:16px;margin-top:28px;border-bottom:1px solid #222;padding-bottom:6px}}
 .muted{{color:#8b949e;font-weight:400;font-size:12px}}
 .grid{{display:flex;flex-wrap:wrap;gap:18px}}
 .chart{{background:#11161f;border:1px solid #222;border-radius:8px;padding:10px}}
 .svg{{width:380px;height:220px}} .ax{{stroke:#333}} .tick{{fill:#8b949e;font-size:10px}}
 .dot{{display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 4px 0 10px;vertical-align:middle}}
 .item{{margin:14px 0;padding:10px;background:#11161f;border:1px solid #222;border-radius:8px}}
 .players{{display:flex;flex-wrap:wrap;gap:10px}} .pl{{font-size:12px}} .pl span{{display:block;color:#8b949e}}
 audio{{height:30px}}
 table{{border-collapse:collapse;font-size:12px;margin-top:8px}} td,th{{border:1px solid #222;padding:4px 8px;text-align:right}} th{{color:#8b949e}}
</style>
<h1>FMS-Bench — mumble-ratio scoreboard <span class="muted">(NUS-48E, {len(items)} items)</span></h1>
<p class="muted">Score a generated vocal against the ground-truth human vocal as the mumble ratio ρ rises.
Generators: <b>oracle</b> = the clean vocal (ceiling), <b>passthrough</b> = the mumble itself (floor).
The real FMS sing pipeline slots in as a third curve once armed. Legend: {legend}</p>
<h2>Metric vs mumble ratio</h2><div class="grid">{charts}</div>
<h2>Listen — the synthetic mumbles per item</h2>{"".join(rows)}
"""
    open(out_html, "w").write(doc)
    return {"items": len(items), "runs": len(runs), "generators": gens,
            "board": {g: {"ratios": board[g]["ratios"],
                          "bag_coverage": board[g]["correctness"].get("bag_coverage"),
                          "onset_f1": board[g]["correctness"].get("f1"),
                          "pq": board[g]["naturalness"].get("pq")} for g in gens}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--html", required=True)
    ap.add_argument("--root", default=os.path.expanduser("~/mosh-fms-ksb"))
    a = ap.parse_args()
    runs = load_runs(a.dirs)
    if not runs:
        print("no runs found in", a.dirs)
        return 1
    summary = render_html(runs, a.html, a.root)
    print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
