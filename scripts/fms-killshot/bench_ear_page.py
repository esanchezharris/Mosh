#!/usr/bin/env python3
"""Blind ear gate for the performance-transfer round.

The benchmark nominates; the ear decides. Per song this serves three arms under unlinked
labels, in a deterministic per-song shuffle so position carries no information:

  today   the shipping chain (render + phrase timing-snap)          measured 0.303 (below band)
  fix     + per-note dynamics transfer                              measured 0.414 (IN BAND)
  control + per-FRAME dynamics transfer                             measured 0.726 (overshoot)

`control` is the implementation the owner already rejected by ear months ago, included
deliberately: if it ranks worst again, the whole measurement apparatus is validated against
a known answer. If it ranks BEST, the band metric is wrong and Phase 2 must be reconsidered.

Your own finished take and your mumble are shown labeled (not blind) as anchors.

The label mapping is written OUTSIDE the served directory so the page cannot leak it.
Run:  bench_ear_page.py && (cd <serve dir> && python3 -m http.server 8199)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ARMS = {"today": "pipeline+snap", "fix": "snap+dyn:note", "control": "snap+dyn:frame"}


def blind_order(song, keys):
    """Deterministic per-song permutation — stable across rebuilds, unguessable from position."""
    ranked = sorted(keys, key=lambda k: hashlib.sha256(f"{song}:{k}".encode()).hexdigest())
    return dict(zip("ABC", ranked))


def build(run_json, out_dir):
    rows = json.load(open(run_json))
    clips = os.path.join(out_dir, "clips")
    os.makedirs(clips, exist_ok=True)
    mapping, cards = {}, []

    for r in rows:
        song = r["item"].replace("own-", "")
        arms = r["arms"]
        have = [k for k, a in ARMS.items() if a in arms and arms[a].get("wav")]
        if len(have) < 2:
            continue
        order = blind_order(song, have)
        mapping[song] = order

        blind_html = []
        for letter, key in order.items():
            src = arms[ARMS[key]]["wav"]
            dst = f"{song}_{letter}.wav"
            shutil.copyfile(src, os.path.join(clips, dst))
            blind_html.append(
                f'<div class="arm"><div class="lab">{letter}</div>'
                f'<audio controls preload="none" src="clips/{dst}"></audio></div>')

        anchors = []
        for key, label in (("mumble", "your mumble (the input)"),
                           ("reference", "your finished take (the target)")):
            if key in arms and arms[key].get("wav"):
                dst = f"{song}_{key}.wav"
                shutil.copyfile(arms[key]["wav"], os.path.join(clips, dst))
                anchors.append(
                    f'<div class="arm anchor"><div class="lab">{label}</div>'
                    f'<audio controls preload="none" src="clips/{dst}"></audio></div>')

        cards.append(f"""<section>
  <h2>{song}</h2>
  <p class="ctx">Anchors — not blind:</p>
  {''.join(anchors)}
  <p class="ctx">Blind. Which sounds most like <em>your performance</em>? Rank them, and say
     if any has audible volume automation (level moving in a way you didn't sing).</p>
  {''.join(blind_html)}
</section>""")

    html = f"""<!doctype html><meta charset=utf-8>
<title>FMS — performance transfer, blind ear gate</title>
<style>
 body{{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;
       padding:0 20px;color:#1a1a1a}}
 h1{{font-size:22px;margin-bottom:4px}} h2{{font-size:17px;margin:28px 0 10px}}
 section{{border-top:1px solid #e5e5e5;padding-top:8px;margin-top:28px}}
 .arm{{display:flex;align-items:center;gap:14px;margin:8px 0}}
 .lab{{font-weight:600;min-width:190px}} .anchor .lab{{font-weight:400;color:#666}}
 audio{{flex:1;height:34px}} .ctx{{color:#555;margin:14px 0 6px}}
 .note{{background:#f7f7f5;padding:14px 16px;border-radius:8px;color:#333}}
</style>
<h1>Performance transfer — blind ear gate</h1>
<p class="note">The pipeline was measured as <strong>solving the words and breaking the
performance</strong>. Three candidates below, blind and shuffled per song. The measurements
say one lands where a second human take of the same song would sit, and one overshoots into
"the envelope was painted on". <strong>Your ear decides which — the numbers only chose who
got to be here.</strong><br><br>
For each song: rank A/B/C, and flag anything where you can hear the <em>level moving</em>
rather than the words ending naturally.</p>
{''.join(cards)}
"""
    open(os.path.join(out_dir, "index.html"), "w").write(html)
    return mapping


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.path.expanduser("~/mosh-fms-ksb/bench/own-run/own_run.json"))
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/ear-gate"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    mapping = build(a.run, a.out)
    # mapping lives OUTSIDE the served dir so the page cannot leak the answer
    key_path = os.path.join(os.path.dirname(a.out.rstrip("/")), "ear-gate-KEY.json")
    json.dump(mapping, open(key_path, "w"), indent=1, sort_keys=True)
    print(f"page  : {os.path.join(a.out, 'index.html')}")
    print(f"key   : {key_path}  (outside the serve root)")
    print(f"serve : cd {a.out} && python3 -m http.server 8199")
    for song, order in sorted(mapping.items()):
        print(f"  {song}: {len(order)} blind arms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
