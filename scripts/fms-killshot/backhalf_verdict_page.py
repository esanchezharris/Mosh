#!/usr/bin/env python3
"""The what-works-better page — SoulX (guaranteed words) vs the ACE arms, one section.

Everything the owner needs to pick the word-render lane, on the single clean page: the raw
mumble, the SoulX score-mode render (words by construction; rented-GPU, pod destroyed), and
the ACE arms the audit measured (flow-edit grows band in the rests; cover 0.7 echoes the
mumble). Each card carries its honest metrics. Also writes a stereo mumble-L/render-R A/B
for the SoulX arm so timing is judgeable the same way the beeps were.
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "service"))
from soulx import ab_mix  # noqa: E402

ROOT = Path("~/mosh-fms-ksb/used2").expanduser()
SERVE = ROOT / "asserted-proof"
BH = ROOT / "asserted-proof/back-half"
PAGE = SERVE / "index.html"

CARDS = [
    dict(name="SoulX score-mode — words GUARANTEED by construction", wav="voice-soulx.wav",
         tone="#3fb950", metrics="voice-only render · words follow the written verse in order · rested where scored",
         blurb="The singing model: it sings the exact per-syllable score (your B words on your measured notes). "
               "Rendered on a rented GPU from a fresh 30s slice of your dry pella; pod terminated, voice data destroyed."),
    dict(name="SoulX vs your mumble (stereo check)", wav="ab-soulx.wav",
         tone="#58a6ff", metrics="your mumble LEFT · SoulX RIGHT · same clock (−50 ms best-lag: aligned)",
         blurb="Headphones — the same left/right timing check the beep guides used."),
    dict(name="ACE flow-edit (audited: band grows in your rests)", wav="voice-flowedit.wav",
         tone="#d29922", metrics="gapFill 0.37 vs take floor 0.07 · words partially land",
         blurb="Kept for comparison. The music model fills your silence with instruments; caption can't stop it "
               "(probe below)."),
    dict(name="ACE flow-edit + 'no instruments' caption (probe)", wav="voice-flowedit-vocalcap.wav",
         tone="#d29922", metrics="gapFill 0.33 — barely moved · words still mush",
         blurb="The caption experiment: explicit a-cappella instruction. Verdict: the prior fills rests regardless."),
    dict(name="ACE cover 0.7 (audited: echoes the mumble)", wav="voice-cover07.wav",
         tone="#f85149", metrics="envCorr 0.95 to the take · zero written words land",
         blurb="Sounds most like the take because it IS the take — copies your mumble's own words back."),
]


def main() -> int:
    words = [w["text"] for w in json.loads((BH / "flowfit-ab.json").read_text())["words"] if w.get("text")]
    ab_mix.stereo_ab(str(SERVE / "mumble-section.wav"), str(SERVE / "voice-soulx.wav"),
                     str(SERVE / "ab-soulx.wav"), sr=44100, right_gain=0.9)

    cards = "".join(f"""
      <div class="card" style="border-left:3px solid {c['tone']}">
        <div class="chead"><h2>{html.escape(c['name'])}</h2></div>
        <p class="metrics" style="color:{c['tone']}">{html.escape(c['metrics'])}</p>
        <p class="blurb">{html.escape(c['blurb'])}</p>
        <audio controls preload="metadata" src="{c['wav']}"></audio>
      </div>""" for c in CARDS if (SERVE / c["wav"]).is_file())
    rows = "".join(f"<tr><td class='idx'>L{i}</td><td class='txt'>{html.escape(w)}</td></tr>"
                   for i, w in enumerate(words))
    PAGE.write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — which lane sings the words?</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead h2{{font-size:15px;margin:0}} .blurb{{color:#8b949e;font-size:13px;margin:6px 0 10px}}
  .metrics{{font-size:12px;font-weight:600;margin:6px 0 0}}
  audio{{width:100%}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}}
</style></head><body><div class="wrap">
  <h1>Used2 — which lane actually sings the words?</h1>
  <p class="sub">Same ~14s section, same written verse. The audit's numbers on every card; your ear makes the call.</p>
  <div class="card ref"><h2>Your raw mumble (reference)</h2>
    <audio controls preload="metadata" src="mumble-section.wav"></audio></div>
  {cards}
  <div class="card"><h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px">The written verse (all renders were told to sing this)</h2>
    <table><tbody>{rows}</tbody></table></div>
</div></body></html>""")
    print(f"page -> {PAGE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
