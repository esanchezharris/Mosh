#!/usr/bin/env python3
"""By-ear A/B bench — which mumble→words approach actually sits on the take?

Owner verdict: the earlier free-invention verse felt disconnected, the fit% was hollow, and
the guide couldn't be lined up against the mumble. This builds the decision the owner asked
for: on ONE short section, three candidates, each heard WITH the raw mumble (mumble in the
LEFT ear, the words-on-your-melody guide in the RIGHT), plus an honest "sounds like your
take" score instead of a count.

    A — invent-freely      (today's approach: blank seed, LLM writes it all)
    B — keep-real + gaps    (keep the take's confident words, invent only the filler)
    C — phonetic-echo       (invent, but pick the wording that most ECHOES your sound)

Product logic (flowspec preserve_words / soundmatch / ab_mix / complete_verse) is TDD'd;
this is composition + I/O. Reads ~/mosh-fms-ksb (never git); writes the single clean page.
"""
from __future__ import annotations

import copy
import html
import json
import os
import subprocess
import sys
from pathlib import Path

_OWNER_ENV = "/Users/emiliosanchez-harris/Documents/ClaudeMosh/ui/.env.local"
if os.path.isfile(_OWNER_ENV):
    os.environ["MOSH_BRAIN_ENV"] = _OWNER_ENV

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "service"))

import brain_client  # noqa: E402
from adapters import soulx_adapter  # noqa: E402
from lyrics import core, flowspec, soundmatch  # noqa: E402
from soulx import ab_mix  # noqa: E402

ROOT = Path("~/mosh-fms-ksb/used2").expanduser()
BH = ROOT / "asserted-proof/back-half"
SERVE = ROOT / "asserted-proof"
SKELETON = BH / "skeleton.json"
RAW_SRC = BH / "source-backhalf-48k.wav"
WORK = BH / "ab-bench"
PAGE = SERVE / "index.html"


def resolve_skeleton() -> Path:
    """The grid every downstream stage measures against. Priority: BH_SKELETON env
    override -> the owner's hand-marked truth (skeleton-truth.json) when it exists ->
    the original detector skeleton. Callers should LOG which grid they got."""
    env = os.environ.get("BH_SKELETON")
    if env:
        return Path(env).expanduser()
    truth = BH / "skeleton-truth.json"
    return truth if truth.is_file() else SKELETON
BENCH_OUT = BH / "ab-bench.json"
SR = 44100

# One section with clear real content ("scars i feel like scarver" ... "i'm about to").
SECT0, SECT1 = 8.5, 22.5

CHORUS = "Used to fight like invincible, but in the night we got hella close"
THEME = ("Two people who were inseparable and drifted into strangers — nostalgia and regret, "
         "the ache of 'used to'.")

CANDIDATES = [
    ("A", "Invent-freely", "Blank slate — the model writes every line to the rhythm only. Today's approach; the one that felt disconnected.", dict(preserve_words=False, echo_rerank=False)),
    ("B", "Keep your words + fill gaps", "Your confident mumbled words are KEPT in place; the model invents only the filler gaps. Your actual bars survive.", dict(preserve_words=True, echo_rerank=False)),
    ("C", "Phonetic echo", "Invented from scratch, but each line picks the wording that most ECHOES your mumble's vowels — so it feels like your take cleaned up.", dict(preserve_words=False, echo_rerank=True)),
]


def slice_and_rebase(skel: dict, t0: float, t1: float) -> dict:
    """Keep the bars whose first note falls in [t0,t1) and shift every time to a 0-based
    section clock, so the guide lines up with a mumble slice taken from the same t0."""
    out_ls = []
    for ls in skel.get("lineScores") or []:
        slots = ls.get("slots") or []
        if not slots or not (t0 <= float(slots[0]["start"]) < t1):
            continue
        ns = []
        for s in slots:
            seg = [{**g, "start": g["start"] - t0, "end": g["end"] - t0} for g in s.get("segments") or []]
            ns.append({**s, "start": s["start"] - t0, "end": s["end"] - t0, "segments": seg})
        out_ls.append({**ls, "slots": ns})
    bars = {ls["bar"] for ls in out_ls}
    return {**skel,
            "lineScores": out_ls,
            "lines": [l for l in skel.get("lines") or [] if l.get("index") in bars],
            "lineHeard": [h for h in skel.get("lineHeard") or [] if isinstance(h, dict) and h.get("bar") in bars]}


def gen_candidate(sec_skel: dict, preserve_words: bool, echo_rerank: bool) -> list:
    """Generate one candidate's chosen lines for the section (deterministic given the LLM)."""
    spec = flowspec.build_flow_spec(sec_skel, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=preserve_words)
    res = core.complete_verse(spec, chorus=CHORUS, theme=THEME, backend="llm")
    if res.get("backend") != "llm":
        raise SystemExit("brain unavailable — the bench needs the real LLM (check MOSH_BRAIN_ENV).")
    by_index = {l["index"]: l for l in spec["lines"]}
    prop_by_index = {c["index"]: c for c in res["lines"]}
    out = []
    for idx in sorted(by_index):
        line = by_index[idx]
        c = prop_by_index.get(idx, {})
        chosen = (c.get("chosen") or "").strip()
        # C: re-pick the proposal that best echoes the mumble fragment for this line.
        if echo_rerank and c.get("proposals"):
            hint = line.get("themeHint") or ""
            if hint:
                ranked = soundmatch.rank([p.get("text", "") for p in c["proposals"] if p.get("text")], hint)
                if ranked and ranked[0][0]:
                    chosen = ranked[0][0]
        out.append({"index": idx, "text": chosen, "themeHint": line.get("themeHint") or "",
                    "score": line["score"], "syllableTarget": line["syllableTarget"]})
    return out


def echo_score(lines: list) -> float:
    """Slot-weighted mean 'sounds like your take' — soundmatch of each line vs its mumble
    fragment. Lines with no mumble words to echo are skipped."""
    scored = [(soundmatch.similarity(l["text"], l["themeHint"]), l["syllableTarget"])
              for l in lines if l.get("themeHint") and l.get("text")]
    tot = sum(w for _, w in scored)
    return (sum(s * w for s, w in scored) / tot) if tot else 0.0


def build() -> dict:
    WORK.mkdir(parents=True, exist_ok=True)
    skel = json.loads(SKELETON.read_text())
    sec = slice_and_rebase(skel, SECT0, SECT1)
    print(f"section [{SECT0},{SECT1}]s -> {len(sec['lineScores'])} bars", flush=True)
    print(f"LLM: available={brain_client.available()} model={(brain_client.resolve() or {}).get('model')}", flush=True)

    # the raw mumble section (mono 44.1k) = the LEFT-ear reference for every A/B
    mumble = WORK / "mumble-section.wav"
    subprocess.run(["ffmpeg", "-y", "-ss", str(SECT0), "-to", str(SECT1), "-i", str(RAW_SRC),
                    "-ac", "1", "-ar", str(SR), str(mumble)], check=True, capture_output=True)

    cards = []
    for key, name, blurb, opts in CANDIDATES:
        lines = gen_candidate(sec, **opts)
        authored = [{"index": l["index"], "text": l["text"], "asserted": True, "score": l["score"]}
                    for l in lines if l["text"]]
        guide = WORK / f"guide-{key}.wav"
        soulx_adapter.render(str(mumble), str(guide), {"lines": copy.deepcopy(authored)})
        ab = SERVE / f"ab-{key}.wav"
        ab_mix.stereo_ab(str(mumble), str(guide), str(ab), sr=SR, right_gain=0.85)
        es = echo_score(lines)
        print(f"  [{key}] {name}: echo={es:.2f}  lines={len(lines)}", flush=True)
        cards.append({"key": key, "name": name, "blurb": blurb, "echo": es, "lines": lines, "ab": f"ab-{key}.wav"})

    # the mono mumble reference at the serve root too
    subprocess.run(["ffmpeg", "-y", "-i", str(mumble), str(SERVE / "mumble-section.wav")],
                   check=True, capture_output=True)
    out = {"section": [SECT0, SECT1], "chorus": CHORUS, "cards": cards}
    BENCH_OUT.write_text(json.dumps(out, indent=2, default=lambda o: None))
    return out


def render_page(data: dict) -> None:
    ECHO_COLOR = lambda e: "#3fb950" if e >= 0.6 else ("#d29922" if e >= 0.35 else "#f85149")  # noqa: E731
    cards_html = []
    for c in data["cards"]:
        rows = "".join(
            f"<tr><td class='idx'>L{l['index']}</td><td class='txt'>{html.escape(l['text'] or '—')}</td>"
            f"<td class='hint'>{html.escape(l['themeHint'] or '')}</td></tr>"
            for l in c["lines"])
        ec = ECHO_COLOR(c["echo"])
        cards_html.append(f"""
        <div class="card">
          <div class="chead"><span class="tag">{c['key']}</span><h2>{html.escape(c['name'])}</h2>
            <span class="echo" style="color:{ec}">{int(round(c['echo']*100))}% sounds like your take</span></div>
          <p class="blurb">{html.escape(c['blurb'])}</p>
          <audio controls preload="metadata" src="{c['ab']}"></audio>
          <p class="ear">◀ your mumble (left) · the written words on your melody (right) ▶</p>
          <table><tbody>{rows}</tbody></table>
        </div>""")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — which approach sits on your mumble?</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 8px}}
  .tip{{color:#8b949e;font-size:13px;margin:0 0 22px;padding:10px 12px;background:#161b22;border:1px solid #30363d;border-radius:8px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead{{display:flex;align-items:center;gap:10px;flex-wrap:wrap}}
  .tag{{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;border-radius:6px;padding:1px 8px;font-weight:700;font-size:13px}}
  .chead h2{{font-size:16px;margin:0}} .echo{{margin-left:auto;font-size:13px;font-weight:600}}
  .blurb{{color:#8b949e;font-size:13px;margin:8px 0 10px}}
  audio{{width:100%}} .ear{{color:#6e7681;font-size:12px;margin:6px 0 10px;text-align:center}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}} .hint{{color:#6e7681;font-style:italic;font-size:12px;text-align:right}}
  .ref{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px 18px;margin:0 0 18px}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
</style></head><body><div class="wrap">
  <h1>Used2 — which approach actually sits on your mumble?</h1>
  <p class="sub">One ~14-second section of the back half, three ways to turn it into words. Decide by ear.</p>
  <div class="tip"><b>Use headphones.</b> In each player your <b>raw mumble is in the LEFT ear</b> and the
     <b>written words (as tones on your melody) are in the RIGHT</b>, on the same clock — so you can hear
     whether each word lands where you sang. The score is how much the words <i>sound like</i> your take
     (vowel-echo) — not a syllable count.</p>
  <div class="ref"><h2>Your raw mumble (this section, both ears)</h2>
     <audio controls preload="metadata" src="mumble-section.wav"></audio></div>
  {''.join(cards_html)}
</div></body></html>"""
    PAGE.write_text(page)
    print(f"\npage -> {PAGE}", flush=True)


if __name__ == "__main__":
    if "--page-only" in sys.argv:
        render_page(json.loads(BENCH_OUT.read_text()))
    else:
        render_page(build())
