#!/usr/bin/env python3
"""Demo round page — is the problem the LYRICS/ALIGNMENT (owner's hypothesis) or the engine?

Four SoulX renders, same section, same voice ref, same pod session — only the score varies.
Single clean page (replaces index.html per the one-page policy).
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

ROOT = Path("~/mosh-fms-ksb/used2").expanduser()
SERVE = ROOT / "asserted-proof"
BH = ROOT / "asserted-proof/back-half"
PAGE = SERVE / "index.html"

HAND_LINES = ["Scars, I feel like Scarver, old flame gone", "I'm still sorry",
              "old burns on my timeline", "we're too far gone", "still can't pray"]

CARDS = [
    dict(key="d1", wav="voice-soulx-d1-control.wav", tone="#8b949e",
         name="d1 · Control — the render you already judged",
         listen="Baseline. The LLM words with the current alignment."),
    dict(key="d2", wav="voice-soulx-d2-take-words.wav", tone="#58a6ff",
         name="d2 · Your mumble's OWN words, on their own notes",
         listen="If THIS sits naturally, the engine + melody are fine — the problem is which words we wrote. "
                "(Gaps are sung as 'la'.)"),
    dict(key="d3", wav="voice-soulx-d3-hand-fit.wav", tone="#3fb950",
         name="d3 · Hand-fitted lyric — exactly one syllable per note",
         listen="Written by hand to your slots with natural stress. If d3 clearly beats d1, "
                "lyrics + alignment is the lever — we build the alignment-aware writer."),
    dict(key="d4", wav="voice-soulx-d4-pitch-clean.wav", tone="#f85149",
         name="d4 · B-major snap — REJECTED (your ear: more wrong notes; the key is D major)",
         listen="Kept for reference. Snapping to B major moved your D/G/A naturals onto sharps — manufactured sour notes."),
    dict(key="d5", wav="voice-soulx-d5-pitch-Dmaj.wav", tone="#3fb950",
         name="d5 · d3's words snapped to D MAJOR (your key call)",
         listen="The d4 experiment redone in the right key. If the sour notes clean up now, pitch hygiene works — it just needed D major."),
    dict(key="d6", wav="voice-soulx-d6-words-only.wav", tone="#58a6ff",
         name="d6 · your kept words only — phantom slots silenced",
         listen="d2 without the 'la' filler: only the words you really articulated, real rests elsewhere. "
                "If this sits where d2 didn't, the phantom Basic-Pitch slots were the rhythm problem."),
    dict(key="d7", wav="voice-soulx-d7-uncapped.wav", tone="#58a6ff",
         name="d7 · d3's words, raw holds (no cap)",
         listen="The 1.5-beat hold cap removed — sustains run their full measured length. Compare against d3 for phrasing."),
    dict(key="d8", wav="voice-soulx-d8-best.wav", tone="#3fb950",
         name="d8 · composite: D major + raw holds",
         listen="Everything your ear asked for in one render — the best-guess candidate."),
]


def main() -> int:
    words = [w["text"] for w in json.loads((BH / "flowfit-ab.json").read_text())["words"] if w.get("text")]
    cards = "".join(f"""
      <div class="card" style="border-left:3px solid {c['tone']}">
        <h2>{html.escape(c['name'])}</h2>
        <p class="blurb">{html.escape(c['listen'])}</p>
        <audio controls preload="metadata" src="{c['wav']}"></audio>
      </div>""" for c in CARDS if (SERVE / c["wav"]).is_file())
    d1rows = "".join(f"<tr><td class='idx'>L{i}</td><td class='txt'>{html.escape(w)}</td></tr>" for i, w in enumerate(words))
    d3rows = "".join(f"<tr><td class='idx'>L{i}</td><td class='txt'>{html.escape(w)}</td></tr>" for i, w in enumerate(HAND_LINES))
    PAGE.write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — demo round: is it the lyrics?</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .card h2{{font-size:15px;margin:0}} .blurb{{color:#8b949e;font-size:13px;margin:6px 0 10px}}
  audio{{width:100%}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}}
  .cols{{display:flex;gap:16px;flex-wrap:wrap}} .cols>div{{flex:1;min-width:280px}}
  .cols h3{{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 6px}}
</style></head><body><div class="wrap">
  <h1>Used2 — demo round: is the problem the lyrics?</h1>
  <p class="sub">Same section, same voice, same session — only the score changes. Your hypothesis on trial.</p>
  <div class="card ref"><h2>Your raw mumble (reference)</h2>
    <audio controls preload="metadata" src="mumble-section.wav"></audio></div>
  {cards}
  <div class="card"><div class="cols">
    <div><h3>d1 words (LLM)</h3><table><tbody>{d1rows}</tbody></table></div>
    <div><h3>d3 / d4 words (hand-fit)</h3><table><tbody>{d3rows}</tbody></table></div>
  </div></div>
</div></body></html>""")
    print(f"page -> {PAGE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
