#!/usr/bin/env python3
"""§13 MEASUREMENT CHECKPOINT — the number that scopes §8 *before* building more of it.

The spec's question: across real top-yield tutorials, how often is the screen actually
READABLE — i.e. is a DAW identifiable, is the piano-roll visible (→ §5 MIDI), is a synth
GUI / plugin name surfaced (→ §5b patch-read)? The answer sets how much §8 (render-in-the-
loop refine + substitute) has to carry:

  * synth GUI readable often  → §5b + §8-refine is the path (lean on the screen).
  * synth GUI rarely shown     → §8-substitute is core (you must approximate unowned/unread
                                  patches), and §9's render-layer fallback covers the rest.

This runs §4 (video→recipe, --no-transcribe for speed + to dodge the av/cv2 dylib clash)
over N discovered tutorials and aggregates the §2 detection signals. It does NOT yet read
knob VALUES (that needs calibrated per-synth profiles) — it measures the *prerequisite*:
can the relevant surface even be seen? Honest, and exactly the input §8's scope needs.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/measurement_checkpoint.py [N]

Gated: needs yt-dlp + the video stack (setup-teardown.sh --with-video --with-sourcing).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(_HERE)
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

QUERIES = [
    "fl studio trap beat tutorial from scratch",
    "ableton house track tutorial from scratch",
    "making a beat serum tutorial",
    "logic pro hip hop beat tutorial",
    "vital synth bass tutorial how to",
]
SECTION = (120.0, 180.0)  # a mid-tutorial minute — past the talking-head intro


def discover(n: int) -> list[dict]:
    """Spread N picks across the query set so the census isn't one-DAW-biased."""
    per = max(1, n // len(QUERIES) + 1)
    seen: set = set()
    out: list[dict] = []
    for q in QUERIES:
        try:
            r = subprocess.run(
                ["yt-dlp", "--flat-playlist", "--dump-json", "--no-warnings", f"ytsearch{per}:{q}"],
                capture_output=True, text=True, timeout=120, check=False)
        except Exception:
            continue
        for ln in r.stdout.splitlines():
            try:
                d = json.loads(ln)
            except Exception:
                continue
            vid = d.get("id")
            dur = d.get("duration") or 0
            if vid and vid not in seen and 90 < dur < 6000:
                seen.add(vid)
                out.append({"id": vid, "title": (d.get("title") or "")[:70], "query": q})
            if len(out) >= n:
                return out
    return out


def run_one(vid: str, out_root: str) -> dict | None:
    cli = os.path.join(_HERE, "video2recipe", "cli.py")
    py = sys.executable
    try:
        r = subprocess.run(
            [py, cli, "--url", vid, "--out", out_root, "--section", str(SECTION[0]),
             str(SECTION[1]), "--no-transcribe", "--max-frames", "18", "--every", "3.5"],
            capture_output=True, text=True, timeout=300, check=False,
            env=dict(os.environ, PYTHONPATH=_SERVICE))
    except Exception as e:  # noqa: BLE001
        return {"id": vid, "ok": False, "error": str(e)[:120]}
    # the cli prints a JSON summary; grab the last JSON object on stdout
    txt = r.stdout.strip()
    start = txt.rfind("{")
    if start < 0:
        return {"id": vid, "ok": False, "error": (r.stderr or txt)[-160:]}
    try:
        return json.loads(txt[start:]) if txt[start:].count("{") == 1 else json.loads(txt[txt.find("{"):])
    except Exception:
        try:
            return json.loads(txt[txt.find("{"):])
        except Exception:
            return {"id": vid, "ok": False, "error": "unparseable cli output"}


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    if not subprocess.run(["which", "yt-dlp"], capture_output=True).returncode == 0:
        print("  SKIP  yt-dlp not on PATH (setup-teardown.sh --with-sourcing)")
        return 0
    try:
        import cv2  # noqa: F401
    except Exception:
        print("  SKIP  video stack absent (setup-teardown.sh --with-video)")
        return 0

    vids = discover(n)
    if not vids:
        print("  SKIP  discovery returned no tutorials")
        return 0
    print(f"  §13 census over {len(vids)} real tutorials (section {SECTION[0]:.0f}-{SECTION[1]:.0f}s):")

    out_root = tempfile.mkdtemp(prefix="td-census-")
    rows = []
    for v in vids:
        res = run_one(v["id"], out_root)
        if not res or not res.get("ok"):
            print(f"    ✗ {v['id']}  {(res or {}).get('error','failed')[:60]}")
            continue
        det = res.get("detected", {})
        rows.append({
            "id": v["id"], "title": v["title"],
            "daw": det.get("daw", "unknown"),
            "pianoroll": bool(det.get("pianoroll")),
            "plugins": det.get("plugins", []),
            "tempo": det.get("tempo"), "key": det.get("key"),
            "frames": res.get("frames_scanned", 0),
        })
        print(f"    ✓ {v['id']}  daw={rows[-1]['daw']:<10} pianoroll={rows[-1]['pianoroll']!s:<5} "
              f"plugins={rows[-1]['plugins']}  tempo={rows[-1]['tempo']}")

    if not rows:
        print("  no tutorials processed (all failed)")
        return 1

    n_ok = len(rows)
    daw_id = sum(1 for r in rows if r["daw"] != "unknown")
    pr = sum(1 for r in rows if r["pianoroll"])
    synth = sum(1 for r in rows if r["plugins"])
    meta = sum(1 for r in rows if r["tempo"] or r["key"])

    print(f"\n  ── §13 readability census (n={n_ok}) ──")
    print(f"    DAW identified:        {daw_id}/{n_ok}  ({100*daw_id/n_ok:.0f}%)")
    print(f"    piano-roll visible:    {pr}/{n_ok}  ({100*pr/n_ok:.0f}%)   → §5 MIDI route")
    print(f"    synth/plugin surfaced: {synth}/{n_ok}  ({100*synth/n_ok:.0f}%)   → §5b patch-read candidate")
    print(f"    tempo/key on screen:   {meta}/{n_ok}  ({100*meta/n_ok:.0f}%)")
    pct = 100 * synth / n_ok
    verdict = ("§5b + §8-refine is the path (synth GUIs are usually shown)" if pct >= 60 else
               "§8-substitute is CORE (synth GUIs rarely readable → must approximate unowned patches)"
               if pct < 35 else
               "mixed regime — §5b where shown, §8-substitute for the rest")
    print(f"\n  →  §8 scope: {verdict}")
    print("  (note: this measures whether the surface is SEEN; reading knob VALUES needs the "
          "per-synth profiles §5b calibration — the next rung.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
