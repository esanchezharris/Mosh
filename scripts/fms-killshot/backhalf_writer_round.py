#!/usr/bin/env python3
"""Writer round — K=3 full back-half candidates through the ENFORCED flow writer, one pod.

Writer v2 recipe per line (all owner-certified or TDD'd this session):
    slots: tidy_segments (glitch/ornament cleanup) → condition_slots(1.5 beats)
           → snap_slots_to_key("D major")
    words: trust-tiered seeds (junk → echo-the-sound targets) + break HARD-GATE +
           stress/echo ranking + syllable-exact (tol 0), chorus-resolving coherence.

Candidates (same melody, same enforcement — different writer settings):
    A flow    the enforced writer, straight
    B voice   + styleBias (the owner's own chorus lines seed the style corpus)
    C alt     a different draw (regen=1 per line) for diversity

Phases:  build → (pod run via backhalf_sing_remote.sh, SING_SCRIPT=multi) → assemble.
Nothing under ~/mosh-fms-ksb enters git.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backhalf_ab_bench import BH, CHORUS, ROOT, THEME  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
import brain_client  # noqa: E402
from lyrics import core, flowspec, style_corpus  # noqa: E402
from soulx import flowfit  # noqa: E402
from soulx import score as sx  # noqa: E402

HANDOFF = BH / "sing-handoff"
SCORES = HANDOFF / "scores"
SERVE = ROOT / "asserted-proof"
KIT = ROOT / "daw-kit"
MANIFEST = BH / "writer-round-manifest.json"
KEY, MAX_BEATS, CHUNK_S, SPLIT_S = "D major", 1.5, 20.0, 55.06

OWN_LINES = ["Yeah we used to fight like invincible",
             "But in the night we got hella close"]     # the owner's own chorus — corpus seed

# Mouth round (2026-07-12): the owner picked A ("flow") but heard "the mouth sounds and
# mouth shapes are just way off" — so this round regenerates the A config under the NEW
# mouth enforcement (every heard word's sounds constrain the writer), two draws.
CANDS = [("M1", "mouth", dict(styleBias=False, regen=0)),
         ("M2", "mouth alt", dict(styleBias=False, regen=1))]


def recipe_slots(slots: list) -> list:
    return flowfit.snap_slots_to_key(
        flowfit.condition_slots(flowfit.tidy_segments(slots), bpm=138.0, max_beats=MAX_BEATS),
        key=KEY)


def gen_candidate(spec: dict, style_bias: bool, regen_n: int) -> list:
    sp = copy.deepcopy(spec)
    sp["styleBias"] = style_bias
    regen = {l["index"]: regen_n for l in sp["lines"]} if regen_n else None
    res = core.complete_verse(sp, chorus=CHORUS, theme=THEME, regen=regen, backend="llm")
    if res.get("backend") != "llm":
        raise SystemExit(f"expected llm backend, got {res.get('backend')}")
    out = []
    for c in res["lines"]:
        top = (c.get("proposals") or [{}])[0]
        rejected = sum(1 for p in c.get("proposals") or [] if p.get("breaksOk") is False)
        m_rejected = sum(1 for p in c.get("proposals") or [] if p.get("mouthOk") is False)
        out.append({"index": c["index"], "text": (c.get("chosen") or "").strip(),
                    "passes": bool(top.get("passes")), "stressTerm": top.get("stressTerm"),
                    "echoTerm": top.get("echoTerm"), "mouthSim": top.get("mouthSim"),
                    "fallback": top.get("fallback"),
                    "breaksRejected": rejected, "mouthRejected": m_rejected})
    return out


def chunk_scores(key: str, lines_meta: list, spec_lines: dict) -> list:
    """Chunk one candidate's lines into <=CHUNK_S rebased scores; returns chunk manifests."""
    chunks, cur, cur_start = [], [], None
    for m in lines_meta:
        l = spec_lines[m["index"]]
        if not m["text"]:
            continue
        if cur and l["startS"] - cur_start > CHUNK_S:
            chunks.append(cur)
            cur, cur_start = [], None
        if cur_start is None:
            cur_start = l["startS"]
        cur.append((m, l))
    if cur:
        chunks.append(cur)
    out = []
    for ci, chunk in enumerate(chunks):
        off = max(0.0, chunk[0][1]["startS"] - 0.1)
        rebased = []
        for m, l in chunk:
            # STRICT COUNT belt: an off-count line must never reach the score author
            # (its pad/squeeze policies are exactly the "count and timing off" the
            # owner heard). The writer guarantees this now — fail loudly if not.
            n = core.syllables(m["text"])
            assert n == len(l["score"]["slots"]), \
                f"L{m['index']}: {n} syllables vs {len(l['score']['slots'])} slots — {m['text']!r}"
            slots = [{**s, "start": round(s["start"] - off, 4), "end": round(s["end"] - off, 4),
                      "segments": [{**g, "start": round(g["start"] - off, 4),
                                    "end": round(g["end"] - off, 4)} for g in s["segments"]]}
                     for s in recipe_slots(l["score"]["slots"])]
            rebased.append({"text": m["text"], "asserted": True,
                            "score": {**l["score"], "slots": slots}})
        r = sx.author_score(rebased)
        assert r.get("ok"), (key, ci, r)
        name = f"{key}-c{ci:02d}"
        (SCORES / f"{name}.json").write_text(json.dumps(r["score"], indent=1))
        out.append({"name": name, "offsetS": round(off, 3), "durationS": r["duration_s"]})
    return out


def build() -> int:
    added = style_corpus.StyleCorpus().add_lines(OWN_LINES, {"source": "used2-chorus"})
    print(f"style corpus: +{added} owner lines ({style_corpus.default_corpus_path()})", flush=True)
    if not brain_client.available():
        raise SystemExit("brain unavailable — check MOSH_BRAIN_ENV")

    skel = json.loads((BH / "skeleton.json").read_text())
    spec = flowspec.build_flow_spec(skel, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=True)
    spec_lines = {l["index"]: l for l in spec["lines"]}
    n_echo = sum(len(l["echoTargets"]) for l in spec["lines"])
    n_verb = sum(1 for l in spec["lines"] for t in l["seedText"].split() if t != "___")
    print(f"{len(spec['lines'])} lines · {n_verb} trusted verbatim words · {n_echo} echo targets · "
          f"breaks {[l['breaks'] for l in spec['lines']]}", flush=True)

    SCORES.mkdir(parents=True, exist_ok=True)
    for old in SCORES.glob("*.json"):
        old.unlink()
    manifest = {"key": KEY, "candidates": []}
    for key, label, opts in CANDS:
        print(f"\n== candidate {key} ({label})", flush=True)
        metas = gen_candidate(spec, opts["styleBias"], opts["regen"])
        fired = sum(m["breaksRejected"] for m in metas)
        m_fired = sum(m["mouthRejected"] for m in metas)
        sims = [m["mouthSim"] for m in metas if m.get("mouthSim") is not None]
        for m in metas:
            tag = " [FILLER]" if m.get("fallback") == "filler" else ""
            print(f"  L{m['index']:>2} {'✓' if m['passes'] else '✗'} "
                  f"mouth={m['mouthSim']} st={m['stressTerm']} | {m['text']}{tag}", flush=True)
        chunks = chunk_scores(key, metas, spec_lines)
        manifest["candidates"].append({"key": key, "label": label, "chunks": chunks,
                                       "breaksRejectedTotal": fired,
                                       "mouthRejectedTotal": m_fired,
                                       "mouthSimMean": round(sum(sims) / len(sims), 3) if sims else None,
                                       "words": [{"index": m["index"], "text": m["text"],
                                                  "passes": m["passes"],
                                                  "mouthSim": m.get("mouthSim")} for m in metas]})
        mean_txt = f"; mean mouthSim {sum(sims) / len(sims):.3f} (old-round baseline 0.359)" if sims else ""
        print(f"  gate rejections while writing: breaths {fired}, mouth {m_fired}{mean_txt}", flush=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"\nstaged {sum(len(c['chunks']) for c in manifest['candidates'])} scores -> {SCORES}", flush=True)
    return 0


def assemble() -> int:
    man = json.loads(MANIFEST.read_text())
    cards = []
    for cand in man["candidates"]:
        inputs, filters, mixes = [], [], []
        for i, ch in enumerate(cand["chunks"]):
            wav = SERVE / f"voice-soulx-{ch['name']}.wav"
            assert wav.is_file(), f"missing render {wav}"
            inputs += ["-i", str(wav)]
            filters.append(f"[{i}:a]adelay={int(round(ch['offsetS'] * 1000))}:all=1[a{i}]")
            mixes.append(f"[a{i}]")
        graph = ";".join(filters) + f";{''.join(mixes)}amix=inputs={len(mixes)}:normalize=0[out]"
        full = SERVE / f"voice-writer-{cand['key']}.wav"
        subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", "[out]",
                        "-ar", "48000", str(full)], check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-y", "-i", str(full),
                        str(KIT / "demo-clips" / f"writer-{cand['key']}.wav")], check=True, capture_output=True)
        subprocess.run(["ffmpeg", "-y", "-i", str(full), "-af", f"adelay={int(SPLIT_S * 1000)}:all=1",
                        str(KIT / "demo-clips-padded-to-song-start" / f"writer-{cand['key']}.wav")],
                       check=True, capture_output=True)
        rows = "".join(f"<tr><td class='idx'>L{w['index']}</td><td class='txt'>{html.escape(w['text'])}</td></tr>"
                       for w in cand["words"])
        cards.append(f"""
      <div class="card">
        <div class="chead"><span class="tag">{cand['key']}</span><h2>{html.escape(cand['label'])}</h2>
          <span class="stat">breath-gate rejections while writing: {cand['breaksRejectedTotal']}</span></div>
        <audio controls preload="metadata" src="voice-writer-{cand['key']}.wav"></audio>
        <details><summary style="color:#8b949e;font-size:13px;cursor:pointer;margin-top:8px">the lines</summary>
        <table><tbody>{rows}</tbody></table></details>
      </div>""")
    (SERVE / "index.html").write_text(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — writer round: three full back halves</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead{{display:flex;align-items:center;gap:10px;flex-wrap:wrap}} .chead h2{{font-size:16px;margin:0}}
  .tag{{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;border-radius:6px;padding:1px 8px;font-weight:700}}
  .stat{{margin-left:auto;font-size:12px;color:#8b949e}}
  audio{{width:100%;margin-top:8px}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
</style></head><body><div class="wrap">
  <h1>Used2 — writer round: three full back halves</h1>
  <p class="sub">Same melody, same enforced flow (breath gate · stress · sound-echo · D major · exact counts) —
     three writer draws. Also in the daw-kit as writer-A/B/C.wav (plain + padded).</p>
  <div class="card ref"><h2>Raw back half (your take, reference)</h2>
    <audio controls preload="metadata" src="back-half/source-backhalf-48k.wav"></audio></div>
  {''.join(cards)}
</div></body></html>""")
    print(f"assembled {len(man['candidates'])} candidates + page", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(assemble() if "assemble" in sys.argv else build())
