#!/usr/bin/env python3
"""Stage D: blind listening page over the probe output (killshot listening-room style).

For every ranked line: an audio snippet of that span (stdlib wave cut from the take)
plus a SHUFFLED, blind-labeled candidate list (top-5 / bottom-5 / random-5 mixed).
Which label maps to which bucket lives ONLY in <root>/blind_key.json — never in the
page — so the ear test cannot be gamed by reading the source.

The owner ticks every candidate that "sounds like my mumble AND is singable", pastes
the export box into score_picks.py, and that joins picks against the key:
PASS when picks hit the top-5 bucket at >= 2x the random-5 rate.

Usage:  make_probe_page.py <probe-root>          (then: python3 -m http.server -d <root>)
        score_picks via:  make_probe_page.py --score <probe-root> "<pasted picks>"
"""
from __future__ import annotations

import html
import json
import os
import random
import sys
import wave

SEED = 20260811


def cut_snippet(src_wav: str, out_wav: str, start: float, end: float, pad: float = 0.25):
    with wave.open(src_wav, "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        f0 = max(0, int((start - pad) * sr))
        f1 = min(w.getnframes(), int((end + pad) * sr))
        w.setpos(f0)
        frames = w.readframes(f1 - f0)
    with wave.open(out_wav, "wb") as o:
        o.setnchannels(ch)
        o.setsampwidth(sw)
        o.setframerate(sr)
        o.writeframes(frames)


def build(root: str) -> int:
    rng = random.Random(SEED)
    key = {}
    sections = []
    for take in sorted(os.listdir(root)):
        tdir = os.path.join(root, take)
        rpath = os.path.join(tdir, "ranked.json")
        if not os.path.isfile(rpath):
            continue
        with open(rpath, encoding="utf-8") as f:
            ranked = json.load(f)
        with open(os.path.join(tdir, "template.json"), encoding="utf-8") as f:
            template = json.load(f)
        audio = template["audio"]
        rows = []
        for line in ranked["lines"]:
            s, e = line["span"]
            snip_rel = f"{take}/line{line['index']}.wav"
            try:
                cut_snippet(audio, os.path.join(root, snip_rel), s, e)
            except Exception as exc:  # noqa: BLE001 — page still useful without a snippet
                print(f"  snippet failed for {take} line {line['index']}: {exc}",
                      file=sys.stderr)
                snip_rel = None
            entries = [(t["text"], "top") for t in line["top"]] + \
                      [(t["text"], "bottom") for t in line["bottom"]] + \
                      [(t["text"], "random") for t in line["random"]]
            rng.shuffle(entries)
            items = []
            for k, (text, bucket) in enumerate(entries):
                label = f"{take}:L{line['index']}:{k}"
                key[label] = bucket
                items.append(
                    f'<li><label><input type="checkbox" data-id="{html.escape(label)}"> '
                    f"{html.escape(text)}</label></li>")
            snip_html = (f'<audio controls preload="none" src="{html.escape(snip_rel)}">'
                         f"</audio>" if snip_rel else "<em>(no snippet)</em>")
            rows.append(
                f"<div class='line'><h3>line {line['index']} "
                f"({line['syllables']} syllables)</h3>{snip_html}"
                f"<ol>{''.join(items)}</ol></div>")
        sections.append(f"<section><h2>{html.escape(take)} — topic: "
                        f"{html.escape(str(ranked.get('topic')))}</h2>"
                        f"<p><audio controls preload='none' "
                        f"src='{html.escape(os.path.relpath(audio, root))}'></audio> "
                        f"(full take)</p>{''.join(rows)}</section>")

    page = f"""<!doctype html><meta charset="utf-8">
<title>FMS phoneme-probe — blind listening</title>
<style>
 body {{ font: 15px/1.5 -apple-system, sans-serif; margin: 2rem auto; max-width: 60rem; }}
 .line {{ border-top: 1px solid #ccc; padding: .6rem 0; }}
 ol {{ columns: 1; }} li {{ margin: .15rem 0; }}
 textarea {{ width: 100%; height: 7rem; }}
</style>
<h1>Does it sound like your mumble?</h1>
<p>Per line: play the snippet, then tick <strong>every</strong> candidate that
<em>sounds like the mumble AND is singable to it</em>. Candidates are shuffled and
blind — do not overthink, go by ear. When done, press Export and paste the box's
contents into <code>make_probe_page.py --score</code>.</p>
{''.join(sections)}
<h2>Export</h2>
<button onclick="exportPicks()">Export picks</button>
<textarea id="out" placeholder="picks appear here"></textarea>
<script>
function exportPicks() {{
  const ids = [...document.querySelectorAll('input[data-id]:checked')]
      .map(el => el.dataset.id);
  document.getElementById('out').value = JSON.stringify(ids);
}}
</script>
"""
    with open(os.path.join(root, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    with open(os.path.join(root, "blind_key.json"), "w", encoding="utf-8") as f:
        json.dump(key, f, indent=1)
    print(f"wrote {root}/index.html ({len(key)} blind candidates) + blind_key.json")
    print(f"serve:  python3 -m http.server 8189 -d {root}")
    return 0


def score(root: str, picks_json: str) -> int:
    with open(os.path.join(root, "blind_key.json"), encoding="utf-8") as f:
        key = json.load(f)
    picks = json.loads(picks_json)
    buckets = {"top": 0, "bottom": 0, "random": 0}
    for p in picks:
        if p in key:
            buckets[key[p]] += 1
    totals = {"top": 0, "bottom": 0, "random": 0}
    for b in key.values():
        totals[b] += 1
    rates = {b: (buckets[b] / totals[b] if totals[b] else 0.0) for b in buckets}
    print(f"picks: {len(picks)}  hit-rates: " +
          "  ".join(f"{b} {buckets[b]}/{totals[b]} ({rates[b]:.0%})" for b in buckets))
    if rates["random"] == 0 and rates["top"] > 0:
        print("VERDICT: PASS (top picked, random never)")
    elif rates["top"] >= 2 * max(rates["random"], 1e-9):
        print("VERDICT: PASS (top-5 picked at >= 2x the random rate)")
    elif rates["top"] <= rates["random"]:
        print("VERDICT: FAIL (rescoring added nothing the ear can hear)")
    else:
        print("VERDICT: INCONCLUSIVE")
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "--score":
        sys.exit(score(sys.argv[2], sys.argv[3]))
    sys.exit(build(sys.argv[1]))
