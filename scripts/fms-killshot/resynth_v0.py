#!/usr/bin/env python3
"""Resynth v0 — the corrected FMS pipeline end-to-end on a real take (Stage D).

  --phase sheet   take -> notes/F0/env/words -> build_skeleton_spec(extraction) ->
                  PRINT the sheet with provenance markers and STOP. The free human
                  gate: the owner reads his own words in the sheet BEFORE any GPU
                  spend. Writes <out>/sheet.json.
  --phase score   sheet.json -> lyrics.core.complete (LLM when brain configured)
                  fills ONLY fillable lines -> 4dp target score -> <out>/target_score.json
                  + a provenance-marked printout of the final lyrics.

The render itself reuses the proven RunPod one-off pattern (remote/runpod_ksa.sh +
remote_sing.sh); the overlap gate is scripts/fms-killshot/overlap.py.

Usage:
  resynth_v0.py --input take.wav --bpm 134 [--grid 1/16] --out outdir --phase sheet
  resynth_v0.py --out outdir --phase score
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose                      # noqa: E402
from skeleton import core as skcore  # noqa: E402


def _marker(line: dict) -> str:
    o = line.get("origin", "")
    if o == "sung":
        return "SUNG   "
    if o == "partial":
        return "PARTIAL"
    return "mumble "


def print_sheet(spec: dict) -> None:
    print("\n──── the sheet (provenance-marked) ────")
    for ln in spec.get("lines", []):
        body = ln.get("text") or ln.get("seedText", "")
        print(f"  [{_marker(ln)}] {ln['index']:>2} ({ln.get('syllableTarget')} syl "
              f"{ln.get('rhymeGroup')}): {body}")
    st = spec.get("skeleton", {}).get("extraction", {})
    print(f"  extraction: tier={st.get('tier')} kept={st.get('kept')} "
          f"sung={st.get('sung_lines')} partial={st.get('partial_lines')} "
          f"of {len(spec.get('lines', []))} lines\n")


def phase_sheet(args) -> int:
    bp_py = diagnose._venv_python("transcribe/.transcribe.env", "BASIC_PITCH_PY")
    if not bp_py:
        print("FATAL: Basic Pitch venv missing", file=sys.stderr)
        return 2
    sk_py = diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    wh_py = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")

    with tempfile.TemporaryDirectory() as td:
        wav = diagnose._to_wav(os.path.abspath(args.input), td)
        print("1) basic pitch …", flush=True)
        notes_res = diagnose._run_json(bp_py, os.path.join(REPO, "service/transcribe/transcribe_cli.py"), wav, "mono")
        notes = notes_res.get("notes") or []
        print(f"   {len(notes)} notes")
        f0 = None
        if sk_py:
            print("2) FCPE F0 …", flush=True)
            r = diagnose._run_json(sk_py, os.path.join(REPO, "service/skeleton/skeleton_cli.py"), wav)
            f0 = r.get("f0") if r.get("ok") else None
        print("3) envelope …", flush=True)
        pcm = skcore.read_pcm_mono(wav)
        env = skcore.energy_envelope(pcm[0], pcm[1]) if pcm else None
        words = None
        if wh_py:
            print("4) whisper (generous decode) …", flush=True)
            res = diagnose._run_json(wh_py, os.path.join(REPO, "service/whisper/whisper_cli.py"), wav, args.whisper_model)
            if res.get("ok"):
                from phonology import core as ph
                pron = ph.Pronouncer()
                words = []
                for w in res.get("words", []):
                    c = str(w.get("word", "")).strip(" .,!?'\"-").lower()
                    if not any(ch.isalpha() for ch in c):
                        continue
                    words.append({"word": str(w.get("word", "")).strip(),
                                  "start": float(w["start"]), "end": float(w["end"]),
                                  "confidence": float(w.get("confidence", 0) or 0),
                                  "syl": pron.syllables(c) or 1})
                print(f"   {len(words)} words")
        print("5) skeleton + EXTRACTION …", flush=True)
        spec = skcore.build_skeleton_spec(
            notes, f0=f0, bpm=args.bpm, grid=args.grid, env=env, words=words,
            extract_lyrics=True, extract_use_llm=not args.no_llm)
    if not spec.get("ok"):
        print(f"FATAL: {spec.get('error')}", file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "sheet.json"), "w") as f:
        json.dump(spec, f, indent=1)
    print_sheet(spec)
    print(f"sheet -> {args.out}/sheet.json")
    print("STOP: owner reviews the sheet (SUNG lines are verbatim his words) before --phase score.")
    return 0


def phase_score(args) -> int:
    spec = json.load(open(os.path.join(args.out, "sheet.json")))
    from lyrics import core as lyr
    from soulx import score as sx
    print("1) complete() fills ONLY fillable lines (sung lines are skipped/anchors) …", flush=True)
    gen = lyr.complete(spec)
    gen_by_idx = {l.get("index"): l for l in gen.get("lines", [])} if gen.get("ok") else {}
    filled = 0
    for ln in spec["lines"]:
        g = gen_by_idx.get(ln["index"], {})
        props = g.get("proposals") or []
        if props and not (ln.get("text") or "").strip():
            ln["text"] = props[0]["text"]
            ln["origin"] = ln.get("origin") == "partial" and "mixed" or "generated"
            filled += 1
    print(f"   filled {filled} lines (backend={gen.get('backend', '?')})")
    print_sheet(spec)
    print("2) author 4dp score …", flush=True)
    lines = [{"text": ln.get("text") or ln.get("seedText", ""), "score": sc}
             for ln, sc in zip(spec["lines"], spec.get("lineScores") or [])]
    r = sx.author_score(lines, name="resynth-v0")
    if not r.get("ok"):
        print(f"FATAL: {r.get('error')}", file=sys.stderr)
        return 1
    with open(os.path.join(args.out, "target_score.json"), "w") as f:
        json.dump(r["score"], f, indent=1)
    with open(os.path.join(args.out, "sheet-final.json"), "w") as f:
        json.dump(spec, f, indent=1)
    print(f"   events={r['events']} words={r['words']} rests={r['rests']} dur={r['duration_s']}s")
    print(f"score -> {args.out}/target_score.json  (render via remote/remote_sing.sh; gate via overlap.py)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=("sheet", "score"))
    ap.add_argument("--input")
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--grid", default="1/16")
    ap.add_argument("--out", required=True)
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--no-llm", action="store_true", help="tier-1 extraction + fake fill only")
    args = ap.parse_args()
    if args.phase == "sheet":
        if not args.input:
            print("--input required for --phase sheet", file=sys.stderr)
            return 2
        return phase_sheet(args)
    return phase_score(args)


if __name__ == "__main__":
    sys.exit(main())
