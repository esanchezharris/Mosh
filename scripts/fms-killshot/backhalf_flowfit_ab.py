#!/usr/bin/env python3
"""old-B vs new-B — does the flow-fit (rest-the-silence) actually sit better?

The owner picked candidate B (keep your real words) but heard a tone HELD OUT where there's no
mumble — the skeleton captures a long span (up to 1.3s here) as one slot, sung whole. `flowfit.
condition_slots` caps a slot's sung length so the freed tail becomes a REST. This regenerates B
once, renders it two ways (rigid vs flow-fit) over the SAME words, and serves both as stereo
A/Bs (your mumble left, the guide right) so you can hear the held tones become rests.

Composition + I/O over TDD'd pieces (gen_candidate / condition_slots / ab_mix). Reads
~/mosh-fms-ksb (never git); writes the one clean page.
"""
from __future__ import annotations

import copy
import html
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backhalf_ab_bench import (BH, CHORUS, RAW_SRC, SECT0, SECT1, SERVE, SR, THEME,  # noqa: E402
                               gen_candidate, slice_and_rebase)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
from adapters import soulx_adapter  # noqa: E402
from soulx import ab_mix, flowfit  # noqa: E402
from soulx import score as sx  # noqa: E402

SKELETON = BH / "skeleton.json"
PAGE = SERVE / "index.html"
BENCH_OUT = BH / "flowfit-ab.json"
MAX_BEATS = 1.5


def authored_for(lines: list, condition: bool) -> list:
    out = []
    for l in lines:
        if not l["text"]:
            continue
        slots = l["score"]["slots"]
        if condition:
            slots = flowfit.condition_slots(slots, bpm=138.0, max_beats=MAX_BEATS)
        out.append({"index": l["index"], "text": l["text"], "asserted": True,
                    "score": {**l["score"], "slots": slots}})
    return out


def rest_and_maxtone(authored: list) -> tuple:
    """From the authored score: total REST seconds and the single longest held tone."""
    clip = sx.author_score(copy.deepcopy(authored))["score"][0]
    types = [int(t) for t in clip["note_type"].split()]
    durs = [float(d) for d in clip["duration"].split()]
    rest = sum(d for d, t in zip(durs, types) if t == 1)
    maxtone = max((d for d, t in zip(durs, types) if t in (2, 3)), default=0.0)
    return round(rest, 2), round(maxtone, 2)


def build() -> dict:
    skel = json.loads(SKELETON.read_text())
    sec = slice_and_rebase(skel, SECT0, SECT1)
    print(f"section [{SECT0},{SECT1}]s -> {len(sec['lineScores'])} bars", flush=True)
    mumble = BH / "ab-bench" / "mumble-section.wav"
    mumble.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-ss", str(SECT0), "-to", str(SECT1), "-i", str(RAW_SRC),
                    "-ac", "1", "-ar", str(SR), str(mumble)], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(mumble), str(SERVE / "mumble-section.wav")],
                   check=True, capture_output=True)

    lines = gen_candidate(sec, preserve_words=True, echo_rerank=False)   # candidate B

    variants = []
    for key, cond in (("old", False), ("new", True)):
        authored = authored_for(lines, cond)
        guide = BH / "ab-bench" / f"guide-{key}.wav"
        soulx_adapter.render(str(mumble), str(guide), {"lines": copy.deepcopy(authored)})
        ab_mix.stereo_ab(str(mumble), str(guide), str(SERVE / f"ab-{key}.wav"), sr=SR, right_gain=0.85)
        rest, maxtone = rest_and_maxtone(authored)
        print(f"  [{key}] rest={rest}s  longest-held-tone={maxtone}s", flush=True)
        variants.append({"key": key, "rest": rest, "maxtone": maxtone, "ab": f"ab-{key}.wav"})

    out = {"section": [SECT0, SECT1], "maxBeats": MAX_BEATS,
           "words": [{"index": l["index"], "text": l["text"], "hint": l["themeHint"]} for l in lines if l["text"]],
           "variants": variants}
    assert variants[1]["rest"] > variants[0]["rest"], "flow-fit must add rest vs rigid"
    BENCH_OUT.write_text(json.dumps(out, indent=2))
    print(f"\nHELD-TONE: old {variants[0]['maxtone']}s -> new {variants[1]['maxtone']}s   "
          f"REST: old {variants[0]['rest']}s -> new {variants[1]['rest']}s", flush=True)
    return out


def render_page(data: dict) -> None:
    words = "".join(f"<tr><td class='idx'>L{w['index']}</td><td class='txt'>{html.escape(w['text'])}</td>"
                    f"<td class='hint'>{html.escape(w['hint'])}</td></tr>" for w in data["words"])
    old, new = data["variants"][0], data["variants"][1]
    labels = {"old": ("Rigid (before)", "Slots sung whole — a tone holds through your silence.", "#f85149"),
              "new": ("Flow-fit (after)", f"Over-long notes capped (~{data['maxBeats']} beats) → the tail becomes a rest.", "#3fb950")}
    cards = []
    for v in data["variants"]:
        title, blurb, col = labels[v["key"]]
        cards.append(f"""
        <div class="card">
          <div class="chead"><h2 style="color:{col}">{title}</h2>
            <span class="stat">held tone ≤ <b>{v['maxtone']}s</b> · rest <b>{v['rest']}s</b></span></div>
          <p class="blurb">{html.escape(blurb)}</p>
          <audio controls preload="metadata" src="{v['ab']}"></audio>
          <p class="ear">◀ your mumble (left) · the words on your melody (right) ▶</p>
        </div>""")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — flow-fit: rest the silence</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 8px}}
  .tip{{color:#8b949e;font-size:13px;margin:0 0 22px;padding:10px 12px;background:#161b22;border:1px solid #30363d;border-radius:8px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead{{display:flex;align-items:center;gap:10px;flex-wrap:wrap}} .chead h2{{font-size:16px;margin:0}}
  .stat{{margin-left:auto;font-size:12px;color:#8b949e}} .blurb{{color:#8b949e;font-size:13px;margin:8px 0 10px}}
  audio{{width:100%}} .ear{{color:#6e7681;font-size:12px;margin:6px 0 0;text-align:center}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}} .hint{{color:#6e7681;font-style:italic;font-size:12px;text-align:right}}
  .ref{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px 18px;margin:0 0 18px}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
</style></head><body><div class="wrap">
  <h1>Used2 — does resting the silence help?</h1>
  <p class="sub">Same words (your B verse). The only change: over-long notes no longer sustain a tone through your gaps.</p>
  <div class="tip"><b>Headphones.</b> Your <b>raw mumble is LEFT</b>, the words-on-your-melody guide is <b>RIGHT</b>.
     Listen for the spots where the old one drones on and the new one goes quiet with you.</div>
  <div class="ref"><h2>Your raw mumble (this section)</h2><audio controls preload="metadata" src="mumble-section.wav"></audio></div>
  {''.join(cards)}
  <div class="card"><h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px">The words (both)</h2>
     <table><tbody>{words}</tbody></table></div>
</div></body></html>"""
    PAGE.write_text(page)
    print(f"page -> {PAGE}", flush=True)


if __name__ == "__main__":
    render_page(json.loads(BENCH_OUT.read_text()) if "--page-only" in sys.argv else build())
