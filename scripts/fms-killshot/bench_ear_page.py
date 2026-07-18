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

def _page(title, blurb, cards):
    """Shared shell for every ear-gate page. Theme-aware: viewed in a light or dark panel,
    a blind ranking task is useless if the labels are not legible."""
    return f"""<!doctype html><meta charset=utf-8>
<title>FMS — {title}</title>
<style>
 /* Theme-aware: the panel this is viewed in may be light or dark, and a blind ranking
    task is useless if the A/B/C labels aren't legible. */
 :root{{--bg:#fff;--fg:#1a1a1a;--dim:#555;--rule:#e5e5e5;--card:#f7f7f5;--accent:#0b5cad}}
 @media (prefers-color-scheme:dark){{
   :root{{--bg:#151515;--fg:#ededed;--dim:#b0b0b0;--rule:#333;--card:#222;--accent:#6fb4ff}}
 }}
 html,body{{background:var(--bg);color:var(--fg)}}
 body{{font:15px/1.55 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;
       padding:0 20px}}
 h1{{font-size:22px;margin-bottom:4px;color:var(--fg)}}
 h2{{font-size:17px;margin:28px 0 10px;color:var(--accent)}}
 section{{border-top:1px solid var(--rule);padding-top:8px;margin-top:28px}}
 .arm{{display:flex;align-items:center;gap:14px;margin:10px 0}}
 .lab{{font-weight:700;min-width:190px;font-size:17px;color:var(--fg)}}
 .anchor .lab{{font-weight:400;font-size:15px;color:var(--dim)}}
 audio{{flex:1;height:34px}} .ctx{{color:var(--dim);margin:14px 0 6px}}
 .note{{background:var(--card);padding:14px 16px;border-radius:8px;color:var(--fg)}}
 @media (max-width:600px){{.arm{{flex-wrap:wrap}}.lab{{min-width:0}}audio{{width:100%}}}}
</style>
<h1>{title}</h1>
<p class="note">{blurb}</p>
{''.join(cards)}
"""


BLURB_RANK = ("The pipeline was measured as <strong>solving the words and breaking the "
              "performance</strong>. Three candidates below, blind and shuffled per song. "
              "<strong>Your ear decides — the numbers only chose who got to be here.</strong>"
              "<br><br>For each song: rank A/B/C, and flag anything where you can hear the "
              "<em>level moving</em> rather than the words ending naturally.")


ARMS = {"today": "pipeline+snap", "fix": "snap+dyn:note", "control": "snap+dyn:frame"}


def blind_order(song, keys, index=None):
    """Deterministic per-song permutation — stable across rebuilds, position carries nothing.

    COUNTERBALANCED for 2-arm tests. A pure per-song hash can land the same way for every
    song by chance (~25% with 3 songs), and when it does, "I picked B every time" is
    indistinguishable from a position bias — which is exactly what happened on the words A/B
    round and made its verdict unusable. With an `index`, two-arm assignments alternate by
    song so each arm appears first about half the time."""
    ranked = sorted(keys, key=lambda k: hashlib.sha256(f"{song}:{k}".encode()).hexdigest())
    if len(ranked) == 2 and index is not None and index % 2:
        ranked.reverse()
    return dict(zip("ABCDE", ranked))


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

    open(os.path.join(out_dir, "index.html"), "w").write(
        _page("Performance transfer — blind ear gate", BLURB_RANK, cards))
    return mapping


def _crop(src, a, b, dst):
    """Copy `src`'s [a,b] seconds to `dst` (PCM16 mono). Used to put two arms rendered over
    different windows onto the SAME span, so clip length cannot leak which is which."""
    import numpy as np
    import soundfile as sf
    y, sr = sf.read(src)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    i0, i1 = max(0, int(a * sr)), min(len(y), int(b * sr))
    if i1 <= i0:
        i0, i1 = 0, len(y)
    sf.write(dst, np.asarray(y[i0:i1], dtype=np.float32), sr, subtype="PCM_16")
    return dst


def build_compare(run_a, run_b, out_dir, arm, label_a, label_b, blurb, catch_song=None):
    """Blind A/B of the SAME arm across two runs — isolates one change.

    `catch_song`: for that song BOTH blind clips are byte-identical (a catch trial). It looks
    exactly like a real comparison; if the owner hears a difference there, the round is
    position-biased noise and its other verdicts are void. This is the guard for the failure
    that made the last two A/B rounds unusable ("B on all three" under a scrambled map)."""
    rows = {r["item"]: r for r in json.load(open(run_a))}
    rowsb = {r["item"]: r for r in json.load(open(run_b))}
    clips = os.path.join(out_dir, "clips")
    os.makedirs(clips, exist_ok=True)
    mapping, cards = {}, []

    for idx, item in enumerate(sorted(set(rows) & set(rowsb))):
        song = item.replace("own-", "")
        ra, rb = rows[item].get("arms", {}), rowsb[item].get("arms", {})
        if arm not in ra or arm not in rb:
            continue
        is_catch = (song == catch_song)
        order = blind_order(song, [label_a, label_b], index=idx)
        mapping[song] = dict(order, catch=is_catch)
        # The two runs used different windows (fixed 12 s vs phrase-snapped), so the clips
        # differ in LENGTH — a systematic tell that would un-blind the test, and a second
        # variable riding along. Crop both to the same absolute span of the song so the
        # ONLY difference is the words.
        wa, wb = rows[item].get("window", [0, 0]), rowsb[item].get("window", [0, 0])
        t0, t1 = max(wa[0], wb[0]), min(wa[1], wb[1])
        if is_catch:
            # BOTH clips = the SAME source (run B's arm). Identical audio under A and B.
            srcs = {label_a: (rb[arm]["wav"], t0 - wb[0], t1 - wb[0]),
                    label_b: (rb[arm]["wav"], t0 - wb[0], t1 - wb[0])}
        else:
            srcs = {label_a: (ra[arm]["wav"], t0 - wa[0], t1 - wa[0]),
                    label_b: (rb[arm]["wav"], t0 - wb[0], t1 - wb[0])}
        blind_html = []
        for letter, key in order.items():
            dst = f"{song}_{letter}.wav"
            src, a0, a1 = srcs[key]
            _crop(src, a0, a1, os.path.join(clips, dst))
            blind_html.append(f'<div class="arm"><div class="lab">{letter}</div>'
                              f'<audio controls preload="none" src="clips/{dst}"></audio></div>')
        anchors = []
        for key, lab in (("mumble", "your mumble (the input)"),
                         ("reference", "your finished take (the target)")):
            if key in rb and rb[key].get("wav"):
                dst = f"{song}_{key}.wav"
                _crop(rb[key]["wav"], t0 - wb[0], t1 - wb[0], os.path.join(clips, dst))
                anchors.append(f'<div class="arm anchor"><div class="lab">{lab}</div>'
                               f'<audio controls preload="none" src="clips/{dst}"></audio></div>')
        cards.append(f"""<section>
  <h2>{song}</h2>
  <p class="ctx">Anchors — not blind:</p>
  {''.join(anchors)}
  <p class="ctx">Blind. Which is closer to <em>your</em> rhythm and words?</p>
  {''.join(blind_html)}
</section>""")

    open(os.path.join(out_dir, "index.html"), "w").write(_page("Words fix — blind A/B", blurb, cards))
    return mapping


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=os.path.expanduser("~/mosh-fms-ksb/bench/own-run/own_run.json"))
    ap.add_argument("--compare", help="second run json; enables the A/B mode")
    ap.add_argument("--arm", default="pipeline+snap")
    ap.add_argument("--label-a", default="asr-words")
    ap.add_argument("--label-b", default="real-lyrics")
    ap.add_argument("--blurb", default=None)
    ap.add_argument("--catch", default=None, help="song to make a catch trial (identical A/B)")
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/ear-gate"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.compare:
        mapping = build_compare(
            a.run, a.compare, a.out, a.arm, a.label_a, a.label_b,
            a.blurb or "Same pipeline, one change.", catch_song=a.catch)
    else:
        mapping = build(a.run, a.out)
    # mapping lives OUTSIDE the served dir so the page cannot leak the answer
    # Key name is derived from the OUTPUT dir, not just its parent — otherwise two
    # rounds served from sibling dirs silently overwrite each other's answer key.
    key_path = os.path.join(os.path.dirname(a.out.rstrip("/")),
                            f"{os.path.basename(a.out.rstrip(chr(47)))}-KEY.json")
    json.dump(mapping, open(key_path, "w"), indent=1, sort_keys=True)
    print(f"page  : {os.path.join(a.out, 'index.html')}")
    print(f"key   : {key_path}  (outside the serve root)")
    print(f"serve : cd {a.out} && python3 -m http.server 8199")
    for song, order in sorted(mapping.items()):
        tag = "  ← CATCH (identical A/B)" if order.get("catch") else ""
        print(f"  {song}: A={order.get('A')} B={order.get('B')}{tag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
