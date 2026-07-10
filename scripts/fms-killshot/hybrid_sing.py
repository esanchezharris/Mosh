#!/usr/bin/env python3
"""Hybrid rewrite-and-sing driver (FMS, 2026-07-07).

The real Finish-My-Song input is a MUMBLED take of a NEW song. This driver:

  --phase sheet   take -> notes/F0/env/generous-Whisper words -> skeleton + coherence gate
                  (service/lyrics/extract.py) -> per-line origin sung/partial/mumble, with
                  rhyme groups INFERRED from the clear neighbours (rhyme_scheme) and the sung
                  lines LOCKED as anchors. PRINT the diagnosis and STOP: the owner sees which
                  lines are his real words and which will be rewritten. Writes <out>/sheet.json.
  --phase rewrite sheet.json -> core.complete (LLM when brain configured) rewrites ONLY the
                  mumble/partial lines to the DETECTED syllable count, rhyming to the sung
                  anchor in their group. PRINT the final lyric sheet and STOP: the owner
                  approves the new words BEFORE any render spend. Writes <out>/sheet-final.json.
  --phase render  (added once the take is chosen) authors melody-mode metadata (real F0 +
                  new phonemes) for the rewritten spans, SVC for the clear spans, overlays.

Why hybrid, why melody-mode: a mumble's melody + timing are FINE — only the words are broken.
SVC re-voices clear phrases verbatim; melody-mode sings rewritten phrases on the take's real
F0 (control=melody ignores note_pitch), so nothing re-derives pitch/timing from scratch.

The audio decode is owner-gated (Basic Pitch / Whisper / FCPE venvs). The PURE sheet core
(records_from_skeleton / build_sheet) is golden-tested in hybrid_sing_test.py.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from typing import List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import rhyme_scheme  # noqa: E402
import spec_from_take  # noqa: E402


# ── pure sheet core (golden-tested) ────────────────────────────────────────────────────

def _end_word(text: Optional[str], seed: Optional[str]) -> Optional[str]:
    """The line's final word as rhyme evidence — only when the line ENDS on a real word
    (a trailing `___` gap means the true end is unknown → None)."""
    src = (text or "").strip() or (seed or "").strip()
    toks = src.split()
    if not toks:
        return None
    last = re.sub(r"[^a-z']", "", toks[-1].lower())
    return last or None


def records_from_skeleton(sk_spec: dict) -> List[dict]:
    """Skeleton spec lines (build_skeleton_spec, extract_lyrics=True) -> gate records for
    spec_from_take: origin, detected syllable target, the sung text / partial seed, and the
    end-word evidence rhyme inference reads."""
    recs: List[dict] = []
    for line in sk_spec.get("lines", []):
        o = line.get("origin")
        origin = o if o in ("sung", "partial") else "mumble"
        recs.append({
            "index": line.get("index"),
            "origin": origin,
            "syllables": int(line.get("syllableTarget") or 0),
            "text": line.get("text", "") if origin == "sung" else "",
            "seedText": line.get("seedText", "") if origin == "partial" else "",
            "endWord": _end_word(line.get("text"), line.get("seedText")),
        })
    return recs


def build_sheet(sk_spec: dict, topic: Optional[str] = None, mood: Optional[str] = None,
                strictness: Optional[str] = None) -> dict:
    """Skeleton spec -> a core.py rewrite spec with INFERRED rhyme groups + locked sung
    anchors, with the per-line lineScores (render blobs) re-attached 1:1 for the render
    stage and the take provenance carried through."""
    recs = records_from_skeleton(sk_spec)
    grid = sk_spec.get("grid", "1/16")
    strict = strictness or sk_spec.get("rhymeStrictness", "slant")
    spec = spec_from_take.build_spec(recs, topic=topic, mood=mood, grid=grid, strictness=strict)
    if sk_spec.get("lineScores") is not None:
        spec["lineScores"] = sk_spec["lineScores"]      # aligned 1:1 by line order
    for k in ("source", "lineHeard", "skeleton"):
        if k in sk_spec:
            spec[k] = sk_spec[k]
    return spec


# ── sheet printout (provenance-marked, mirrors resynth_v0) ─────────────────────────────

def _marker(line: dict) -> str:
    return {"sung": "SUNG   ", "partial": "PARTIAL", "mixed": "MIXED  ",
            "generated": "REWRITE"}.get(line.get("origin", ""), "mumble ")


def print_sheet(spec: dict, title: str) -> None:
    print(f"\n──── {title} ────")
    for ln in spec.get("lines", []):
        body = ln.get("text") or ln.get("seedText", "") or "(empty — will be rewritten)"
        print(f"  [{_marker(ln)}] {ln.get('index'):>2} ({ln.get('syllableTarget')} syl "
              f"{ln.get('rhymeGroup')}): {body}")
    st = (spec.get("skeleton") or {}).get("extraction", {})
    if st:
        print(f"  gate: tier={st.get('tier')} kept={st.get('kept')} sung={st.get('sung_lines')} "
              f"partial={st.get('partial_lines')} of {len(spec.get('lines', []))} lines")


# ── phase: sheet (decode + gate + infer + STOP) ────────────────────────────────────────

def phase_sheet(args) -> int:
    import diagnose  # noqa: E402  (owner-gated venvs)
    from skeleton import core as skcore  # noqa: E402

    bp_py = diagnose._venv_python("transcribe/.transcribe.env", "BASIC_PITCH_PY")
    if not bp_py:
        print("FATAL: Basic Pitch venv missing (service/transcribe/setup-transcribe.sh)", file=sys.stderr)
        return 2
    sk_py = diagnose._venv_python("skeleton/.skeleton.env", "SKELETON_PY")
    wh_py = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")

    with tempfile.TemporaryDirectory() as td:
        wav = diagnose._to_wav(os.path.abspath(args.input), td)
        print("1) basic pitch …", flush=True)
        notes = (diagnose._run_json(bp_py, os.path.join(REPO, "service/transcribe/transcribe_cli.py"), wav, "mono")
                 .get("notes") or [])
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
        print("5) skeleton + coherence gate …", flush=True)
        sk = skcore.build_skeleton_spec(notes, f0=f0, bpm=args.bpm, grid=args.grid, env=env,
                                        words=words, extract_lyrics=True, extract_use_llm=not args.no_llm)
    if not sk.get("ok"):
        print(f"FATAL: {sk.get('error')}", file=sys.stderr)
        return 1
    sheet = build_sheet(sk, topic=args.topic or None, mood=args.mood or None)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "sheet.json"), "w") as f:
        json.dump(sheet, f, indent=1)
    print_sheet(sheet, "diagnosis (SUNG = his verbatim words; mumble/PARTIAL will be rewritten)")
    print(f"\nsheet -> {args.out}/sheet.json")
    print("STOP: owner reviews what's real vs to-rewrite, then --phase rewrite.")
    return 0


# ── phase: rewrite (fill mumble/partial + STOP) ────────────────────────────────────────

def phase_rewrite(args) -> int:
    from lyrics import core as lyr  # noqa: E402
    sheet = json.load(open(os.path.join(args.out, "sheet.json")))
    print("1) rewrite ONLY mumble/partial lines (sung lines are locked anchors) …", flush=True)
    gen = lyr.complete(sheet, backend=args.backend or None)
    by_idx = {l.get("index"): l for l in gen.get("lines", [])} if gen.get("ok") else {}
    filled = 0
    for ln in sheet["lines"]:
        props = (by_idx.get(ln.get("index"), {}).get("proposals") or [])
        if props and not (ln.get("text") or "").strip():
            ln["text"] = props[0]["text"]
            ln["origin"] = "mixed" if ln.get("origin") == "partial" else "generated"
            filled += 1
    print(f"   rewrote {filled} lines (backend={gen.get('backend', '?')})")
    with open(os.path.join(args.out, "sheet-final.json"), "w") as f:
        json.dump(sheet, f, indent=1)
    print_sheet(sheet, "final lyric sheet (SUNG = his words, REWRITE/MIXED = new words)")
    print(f"\nsheet-final -> {args.out}/sheet-final.json")
    print("STOP: owner approves the rewritten words before --phase render.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=("sheet", "rewrite"))
    ap.add_argument("--input")
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--grid", default="1/16")
    ap.add_argument("--out", required=True)
    ap.add_argument("--topic", default="")
    ap.add_argument("--mood", default="")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--backend", default="", help="force lyrics backend: fake|llm (default auto)")
    ap.add_argument("--no-llm", action="store_true", help="tier-1 extraction only (no LLM judge)")
    args = ap.parse_args()
    if args.phase == "sheet":
        if not args.input:
            print("--input required for --phase sheet", file=sys.stderr)
            return 2
        return phase_sheet(args)
    return phase_rewrite(args)


if __name__ == "__main__":
    sys.exit(main())
