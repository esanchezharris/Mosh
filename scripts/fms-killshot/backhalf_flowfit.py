#!/usr/bin/env python3
"""Stage 3 — the WORKABILITY harness on Used2's back half.

Runs the real mumble skeleton through the whole chain and serves it for the owner's ear:

    skeleton.json  ──flowspec──▶  phrase-lines (real rhythm + pitch + theme hint)
                   ──complete_verse (LLM)──▶  written words, coherent, resolving to the chorus
                   ──author_score──▶  words PLACED on the mumble's exact notes (absolute times)
                   ──soulx fake render──▶  a legato-beep guide: the words sung on YOUR melody
                   ──fit.compute_fit──▶  a per-line + overall NUMBER: does it fit?

Then writes a 3-panel review page (raw mumble · words-on-your-melody · fit numbers) under the
preview-server root. The beep-guide is the honest gate — it isolates rhythm/melody fit before
any voice render. Product logic (flowspec/fit/complete_verse) is TDD'd; this is composition + I/O.

Nothing here is committed data — it reads ~/mosh-fms-ksb (never git) and writes artifacts there.
"""
from __future__ import annotations

import html
import json
import os
import shutil
import sys
from pathlib import Path

# Brain via the owner's own key file — parsed as the brain.env fallback, never printed.
# Force it (the shell may already export an empty ~/Library/Mosh/brain.env; setdefault
# would keep that and silently drop us to the fake filler).
_OWNER_ENV = "/Users/emiliosanchez-harris/Documents/ClaudeMosh/ui/.env.local"
if os.path.isfile(_OWNER_ENV):
    os.environ["MOSH_BRAIN_ENV"] = _OWNER_ENV

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "service"))

import brain_client  # noqa: E402
from adapters import soulx_adapter  # noqa: E402
from lyrics import core, flowspec  # noqa: E402
from soulx import fit as soulx_fit  # noqa: E402

ROOT = Path("~/mosh-fms-ksb/used2").expanduser()
BH = ROOT / "asserted-proof/back-half"
SERVE = ROOT / "asserted-proof"
SKELETON = BH / "skeleton.json"
RAW_SRC = BH / "source-backhalf-48k.wav"               # the recorded take (rendered by the baseline)
GUIDE_WAV = BH / "backhalf-flowfit-guide.wav"
VERSE_OUT = BH / "verse-flowfit.json"
# THE single canonical review page + its two assets live at the serve root under dead-simple
# names — no more one-page-per-round proliferation, no nested paths to get lost in.
PAGE = SERVE / "index.html"
RAW_CLEAN, RAW_REL = SERVE / "raw-mumble.wav", "raw-mumble.wav"
GUIDE_CLEAN, GUIDE_REL = SERVE / "words-on-melody.wav", "words-on-melody.wav"

CHORUS = "Used to fight like invincible, but in the night we got hella close"
THEME = ("Two people who were inseparable and have drifted into strangers — nostalgia, regret, "
         "the ache of 'used to'. The verse reflects on how close they were and how far it's gone, "
         "and lands back into the chorus.")

VERDICT_COLOR = {"clean": "#3fb950", "held": "#58a6ff", "crammed": "#d29922", "squeezed": "#f85149", "skipped": "#6e7681"}


def build() -> dict:
    skel = json.loads(SKELETON.read_text())
    # min_syllables=2 absorbs the mumble's 1-note fragments (they can't be standalone
    # rhyming lines — the brain would cram a full line onto one note).
    spec = flowspec.build_flow_spec(skel, chorus=CHORUS, theme=THEME, gap_s=0.35, min_syllables=2)
    lines = spec["lines"]
    print(f"FlowSpec: {len(lines)} phrase-lines from {len(skel.get('lineScores', []))} bars", flush=True)
    for l in lines:
        print(f"  L{l['index']:>2} {l['syllableTarget']}syl [{l['rhymeGroup']}] "
              f"{l['startS']:>6.2f}-{l['endS']:<6.2f} hint='{l['themeHint']}'", flush=True)

    print(f"\nLLM: available={brain_client.available()} model={(brain_client.resolve() or {}).get('model')}", flush=True)
    # The fake filler is syllable-exact BY CONSTRUCTION → workability would be a meaningless
    # 1.00. The whole point is to test whether REAL words fit, so require the real backend.
    if not brain_client.available():
        raise SystemExit("brain unavailable — the harness needs the real LLM (fake filler is "
                         "syllable-exact and would fake a perfect fit). Check MOSH_BRAIN_ENV.")
    res = core.complete_verse(spec, chorus=CHORUS, theme=THEME, backend="llm")
    if res.get("backend") != "llm":
        raise SystemExit(f"expected llm backend, got {res.get('backend')}")
    print(f"backend={res['backend']}", flush=True)
    chosen = {c["index"]: (c.get("chosen") or "").strip() for c in res["lines"]}

    by_index = {l["index"]: l for l in lines}
    authored = []
    for idx in sorted(by_index):
        txt = chosen.get(idx, "")
        if txt:
            authored.append({"index": idx, "text": txt, "asserted": True, "score": by_index[idx]["score"]})

    report = soulx_fit.compute_fit(authored)
    render_stats = soulx_adapter.render(str((ROOT / "all.wav")), str(GUIDE_WAV),
                                        {"lines": [dict(a) for a in authored]})
    print(f"\nrender: backend={render_stats['backend']} events={render_stats['events']} "
          f"words={render_stats['words']} rests={render_stats['rests']} dur={render_stats['duration_s']}s", flush=True)
    print(f"WORKABILITY: {report['workability']:.2f}  "
          f"(clean {report['clean']} / held {report['held']} / crammed {report['crammed']} / squeezed {report['squeezed']} "
          f"of {report['linesScored']} lines)", flush=True)

    fit_by_index = {r["index"]: r for r in report["lines"]}
    verse_lines = []
    for idx in sorted(by_index):
        l = by_index[idx]
        r = fit_by_index.get(idx, {})
        verse_lines.append({
            "index": idx, "syllableTarget": l["syllableTarget"], "rhymeGroup": l["rhymeGroup"],
            "themeHint": l["themeHint"], "pitchContour": l["pitchContour"],
            "text": chosen.get(idx, ""), "fit": r.get("fit"), "verdict": r.get("verdict"),
            "slots": r.get("slots"), "words": r.get("words"), "syllables": r.get("syllables"),
        })
    out = {"chorus": CHORUS, "theme": THEME, "workability": report["workability"],
           "report": report, "lines": verse_lines, "render": render_stats}
    VERSE_OUT.write_text(json.dumps(out, indent=2))
    return out


def render_page(data: dict) -> None:
    # Copy the two assets to dead-simple root names (preload="metadata" makes the players
    # load their duration immediately, so a stuck 0:00/0:00 never reads as "error").
    shutil.copy(RAW_SRC, RAW_CLEAN)
    shutil.copy(GUIDE_WAV, GUIDE_CLEAN)
    work = data["workability"]
    rep = data["report"]
    rows = []
    for l in data["lines"]:
        v = l["verdict"] or "skipped"
        color = VERDICT_COLOR.get(v, "#6e7681")
        fitpct = int(round((l["fit"] or 0) * 100))
        rows.append(f"""
        <tr>
          <td class="idx">L{l['index']}</td>
          <td class="txt">{html.escape(l['text'] or '—')}</td>
          <td class="num">{l.get('words') or 0}/{l.get('slots') or l['syllableTarget']}</td>
          <td><span class="badge" style="background:{color}22;color:{color};border:1px solid {color}55">{v}</span></td>
          <td class="fit"><div class="bar"><span style="width:{fitpct}%;background:{color}"></span></div><em>{fitpct}%</em></td>
          <td class="hint">{html.escape(l['themeHint'] or '')}</td>
        </tr>""")
    workcolor = "#3fb950" if work >= 0.85 else ("#d29922" if work >= 0.6 else "#f85149")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — Back-half workability</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:860px;margin:0 auto;padding:28px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 24px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px 20px;margin:0 0 18px}}
  .card h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 10px}}
  audio{{width:100%}}
  .big{{font-size:40px;font-weight:700;color:{workcolor};line-height:1}}
  .biglabel{{color:#8b949e;font-size:13px;margin-top:4px}}
  table{{width:100%;border-collapse:collapse;font-size:13px}}
  td{{padding:7px 8px;border-top:1px solid #21262d;vertical-align:middle}}
  .idx{{color:#6e7681;white-space:nowrap;width:34px}}
  .txt{{font-weight:600}} .num{{color:#8b949e;white-space:nowrap;text-align:center}}
  .hint{{color:#6e7681;font-style:italic;font-size:12px}}
  .badge{{padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;text-transform:capitalize}}
  .fit{{width:120px}} .bar{{background:#21262d;border-radius:4px;height:7px;overflow:hidden;display:inline-block;width:80px;vertical-align:middle}}
  .bar span{{display:block;height:100%}} .fit em{{font-style:normal;color:#8b949e;font-size:11px;margin-left:6px}}
  .legend{{color:#6e7681;font-size:12px;margin-top:10px}}
  .note{{color:#8b949e;font-size:13px}}
</style></head><body><div class="wrap">
  <h1>Used2 — does the written verse fit your mumble?</h1>
  <p class="sub">The back half was pure mumble. Here it is turned into words placed on your exact notes — hear it, then read the numbers.</p>

  <div class="card">
    <h2>1 · Your raw mumble (the take)</h2>
    <audio controls preload="metadata" src="{RAW_REL}"></audio>
    <p class="note">What you actually sang — the melody, rhythm and phrasing the words must fit.</p>
  </div>

  <div class="card">
    <h2>2 · The written words, sung on YOUR melody (legato-beep guide)</h2>
    <audio controls preload="metadata" src="{GUIDE_REL}"></audio>
    <p class="note">Deterministic guide — one tone per word, on the note and at the moment your mumble sang it.
       This is exactly what a voice render will be told to sing. Silence = your rests.</p>
  </div>

  <div class="card" style="display:flex;align-items:center;gap:22px">
    <div><div class="big">{int(round(work*100))}%</div><div class="biglabel">workability</div></div>
    <div class="note">
      {rep['clean']} clean · {rep['held']} held (fine) · {rep['crammed']} crammed · {rep['squeezed']} squeezed
      &nbsp;—&nbsp;of {rep['linesScored']} lines.<br>
      <span class="legend">clean = one word per note · held = a note held (melisma, fine) · crammed/squeezed = too many words for the notes (rushed).</span>
    </div>
  </div>

  <div class="card">
    <h2>3 · Line by line</h2>
    <table><tbody>{''.join(rows)}</tbody></table>
    <p class="legend">words/notes · fit% · and the fragment your mumble hinted there.</p>
  </div>
</div></body></html>"""
    PAGE.write_text(page)
    print(f"\npage -> {PAGE}", flush=True)


if __name__ == "__main__":
    # --page-only rebuilds the single clean page from the last saved verse (no LLM re-run,
    # no new verse) — used to de-clutter without changing the result.
    if "--page-only" in sys.argv:
        render_page(json.loads(VERSE_OUT.read_text()))
    else:
        render_page(build())
