#!/usr/bin/env python3
"""Stage the SoulX rented-GPU handoff — the B verse as a GUARANTEED-words render.

The audit closed the ACE lane for word assertion (diffusion fills rests with band and mushes
new words; caption doesn't fix it). SoulX score-mode is the machine built for this: it sings
EXACTLY the per-syllable score we author. This stages everything `remote_sing_fresh.sh`
needs at ~/ksa/handoff on the pod:

    scores/target_score.json   the B-verse words on the mumble's measured notes
                               (same flowfit-conditioned slots the owner approved by ear)
    refs/own-30s.wav           a fresh 30s slice of the owner's DRY pella (the original
                               KS-A ref wavs were destroyed by design; the pod re-transcribes)

Deterministic: rebuilds the section FlowSpec (same params as the bench), pairs it with the
SAVED B words (no LLM re-run), conditions slots (max_beats=1.5 — the 'rest the silence' fix),
authors via soulx.score.author_score. Nothing here enters git (~/mosh-fms-ksb only).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backhalf_ab_bench import BH, CHORUS, ROOT, SECT0, SECT1, THEME, slice_and_rebase  # noqa: E402
from backhalf_flowfit_ab import MAX_BEATS, authored_for  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
from lyrics import flowspec  # noqa: E402
from soulx import score as sx  # noqa: E402

HANDOFF = BH / "sing-handoff"
REF_START, REF_DUR = 0.35, 30.0     # a dense-sung stretch of the first half (chorus region)


def main() -> int:
    (HANDOFF / "scores").mkdir(parents=True, exist_ok=True)
    (HANDOFF / "refs").mkdir(parents=True, exist_ok=True)

    # 1. rebuild the section spec EXACTLY as the bench did (deterministic), pair saved words
    skel = json.loads((BH / "skeleton.json").read_text())
    sec = slice_and_rebase(skel, SECT0, SECT1)
    spec = flowspec.build_flow_spec(sec, chorus=CHORUS, theme=THEME, gap_s=0.35,
                                    min_syllables=2, preserve_words=True)
    saved = {w["index"]: w["text"] for w in json.loads((BH / "flowfit-ab.json").read_text())["words"]}
    lines = []
    for l in spec["lines"]:
        txt = saved.get(l["index"], "")
        if txt:
            lines.append({"index": l["index"], "text": txt, "themeHint": l["themeHint"],
                          "score": l["score"], "syllableTarget": l["syllableTarget"]})
    assert len(lines) == len(saved), f"line/word pairing drifted: {len(lines)} vs {len(saved)}"

    authored = authored_for(lines, condition=True)      # flowfit condition_slots(max_beats=1.5)
    result = sx.author_score(authored)
    assert result.get("ok"), result
    score_path = HANDOFF / "scores/target_score.json"
    score_path.write_text(json.dumps(result["score"], indent=1))
    print(f"score: {result['events']} events, {result['words']} words, {result['rests']} rests, "
          f"{result['duration_s']}s -> {score_path}", flush=True)

    # 2. fresh voice reference: 30s of the DRY pella (mono 44.1k; pod transcribes it)
    ref = HANDOFF / "refs/own-30s.wav"
    subprocess.run(["ffmpeg", "-y", "-ss", str(REF_START), "-t", str(REF_DUR),
                    "-i", str(ROOT / "nofx.wav"), "-ac", "1", "-ar", "44100",
                    "-c:a", "pcm_s16le", str(ref)], check=True, capture_output=True)
    print(f"ref: {ref} ({ref.stat().st_size // 1024} KiB)", flush=True)
    print(f"\nhandoff READY -> {HANDOFF}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
