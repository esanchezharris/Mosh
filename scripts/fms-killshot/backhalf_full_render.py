#!/usr/bin/env python3
"""Scale the owner-certified d5 recipe to the WHOLE back half.

Recipe (certified by ear, demos 2026-07-11): measured slots + 1.5-beat hold cap
(condition_slots) + D-MAJOR pitch snap (snap_slots_to_key) + syllable-EXACT words
(flowspec syllableTol=0). The writer is the enriched complete_verse: kept mumble words
preserved as anchors, pitch-contour/stress/theme-hint context, chorus resolution.

Two phases (pod run happens between them, via backhalf_sing_remote.sh):
    build     generate the verse, apply the recipe, write chunked scores + manifest
    assemble  place the pulled chunk renders at their offsets -> the full back-half vocal
              (serve root + daw-kit, plain and padded-to-song-start)

Chunks stay ~<=20s (the render length SoulX is proven at); each chunk's slots are rebased
near zero and the offset recorded, so assembly is sample-accurate placement, not guesswork.
"""
from __future__ import annotations

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
from lyrics import core, flowspec  # noqa: E402
from soulx import flowfit  # noqa: E402
from soulx import score as sx  # noqa: E402

HANDOFF = BH / "sing-handoff"
SCORES = HANDOFF / "scores"
SERVE = ROOT / "asserted-proof"
KIT = ROOT / "daw-kit"
MANIFEST = BH / "full-render-manifest.json"
KEY = "D major"
MAX_BEATS = 1.5
CHUNK_S = 20.0
SPLIT_S = 55.06                 # back half starts here on the song clock


def build() -> int:
    skel = json.loads((BH / "skeleton.json").read_text())
    spec = flowspec.build_flow_spec(skel, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=True)
    lines = spec["lines"]
    print(f"back half: {len(lines)} phrase-lines, targets {[l['syllableTarget'] for l in lines]}", flush=True)
    if not brain_client.available():
        raise SystemExit("brain unavailable — check MOSH_BRAIN_ENV")
    res = core.complete_verse(spec, chorus=CHORUS, theme=THEME, backend="llm")
    if res.get("backend") != "llm":
        raise SystemExit(f"expected llm backend, got {res.get('backend')}")
    chosen = {c["index"]: (c.get("chosen") or "").strip() for c in res["lines"]}

    # the certified recipe per line: cap holds, then snap pitches to the song key
    authored = []
    for l in lines:
        txt = chosen.get(l["index"], "")
        if not txt:
            print(f"  !! line {l['index']} came back empty — skipped", flush=True)
            continue
        slots = flowfit.snap_slots_to_key(
            flowfit.condition_slots(l["score"]["slots"], bpm=138.0, max_beats=MAX_BEATS), key=KEY)
        authored.append({"index": l["index"], "text": txt, "asserted": True,
                         "startS": l["startS"],
                         "score": {**l["score"], "slots": slots}})
        print(f"  L{l['index']:>2} ({l['syllableTarget']}syl) {txt}", flush=True)

    # chunk by time; rebase each chunk near zero and record its offset
    SCORES.mkdir(parents=True, exist_ok=True)
    for old in SCORES.glob("*.json"):
        old.unlink()
    chunks, cur, cur_start = [], [], None
    for a in authored:
        if cur and a["startS"] - cur_start > CHUNK_S:
            chunks.append(cur)
            cur, cur_start = [], None
        if cur_start is None:
            cur_start = a["startS"]
        cur.append(a)
    if cur:
        chunks.append(cur)

    manifest = {"key": KEY, "maxBeats": MAX_BEATS, "chunks": [],
                "words": [{"index": a["index"], "text": a["text"]} for a in authored]}
    for ci, chunk in enumerate(chunks):
        off = max(0.0, chunk[0]["startS"] - 0.1)
        rebased = []
        for a in chunk:
            slots = [{**s, "start": round(s["start"] - off, 4), "end": round(s["end"] - off, 4),
                      "segments": [{**g, "start": round(g["start"] - off, 4),
                                    "end": round(g["end"] - off, 4)} for g in s["segments"]]}
                     for s in a["score"]["slots"]]
            rebased.append({"text": a["text"], "asserted": True, "score": {**a["score"], "slots": slots}})
        r = sx.author_score(rebased)
        assert r.get("ok"), (ci, r)
        name = f"chunk-{ci:02d}"
        (SCORES / f"{name}.json").write_text(json.dumps(r["score"], indent=1))
        manifest["chunks"].append({"name": name, "offsetS": round(off, 3),
                                   "durationS": r["duration_s"], "words": r["words"]})
        print(f"  {name}: offset {off:.2f}s, {r['words']} words, {r['duration_s']}s", flush=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    print(f"\nstaged {len(chunks)} chunk scores -> {SCORES}\nnext: pod run, then 'assemble'", flush=True)
    return 0


def assemble() -> int:
    man = json.loads(MANIFEST.read_text())
    inputs, filters, mixes = [], [], []
    for i, ch in enumerate(man["chunks"]):
        wav = SERVE / f"voice-soulx-{ch['name']}.wav"
        assert wav.is_file(), f"missing render {wav}"
        inputs += ["-i", str(wav)]
        filters.append(f"[{i}:a]adelay={int(round(ch['offsetS'] * 1000))}:all=1[a{i}]")
        mixes.append(f"[a{i}]")
    graph = ";".join(filters) + f";{''.join(mixes)}amix=inputs={len(mixes)}:normalize=0[out]"
    full = SERVE / "voice-soulx-backhalf-full.wav"
    subprocess.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", "[out]",
                    "-ar", "48000", str(full)], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(full), "-ar", "48000",
                    str(KIT / "demo-clips" / "FULL-backhalf.wav")], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(full), "-af", f"adelay={int(SPLIT_S * 1000)}:all=1",
                    "-ar", "48000", str(KIT / "demo-clips-padded-to-song-start" / "FULL-backhalf.wav")],
                   check=True, capture_output=True)
    print(f"assembled -> {full}")
    print(f"kit: demo-clips/FULL-backhalf.wav (drop at {SPLIT_S}s) + padded twin (drop at song start)")
    return 0


if __name__ == "__main__":
    sys.exit(assemble() if "assemble" in sys.argv else build())
