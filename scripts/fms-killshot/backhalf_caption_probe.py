#!/usr/bin/env python3
"""Caption probe — is the guitar in the flow-edit render CAPTION-INDUCED?

The audit found the renders ran with an EMPTY caption: nothing ever told the music model
"a-cappella, no instruments", so in the mumble's rests the generation prior fills with band
(measured: gapFill 0.37 vs the take's own 0.07 floor). This re-renders the SAME flow-edit
request with a vocal-only caption on BOTH sides (caption == source_caption keeps the edit
direction lyric-only) and re-measures. It answers one question for the ACE lane:

    caption fixes the gaps AND words land  -> ACE flow-edit stays a candidate
    caption fixes gaps but words still mush -> ACE is sound-only; SoulX carries the words
    guitar persists                          -> the prior fills silence regardless; same verdict

Reuses the voice-render plumbing verbatim; one seed, one window (the n0.0-0.7 lane).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asserted_proof_ace_flowedit import build_flow_edit_request  # noqa: E402
from backhalf_voice_render import (ACE_DIR, BPM, KEYSCALE, ROOT, SECT0, SECT1, SEED, SERVE,  # noqa: E402
                                   VOICE, b_words, run_worker, section_asr)

VOCAL_CAPTION = ("a cappella solo male rap vocal, dry studio recording, voice only, "
                 "no instruments, no drums, no guitar, no backing track")


def main() -> int:
    words = b_words()
    target = "[Verse]\n" + "\n".join(words)
    source = section_asr()
    src_rel = str((VOICE / "source-section-48k.wav").relative_to(ROOT))

    main_request = json.loads((ACE_DIR / "request.json").read_text())
    main_request["params"]["caption"] = VOCAL_CAPTION   # builder copies this into BOTH sides
    fe = build_flow_edit_request(main_request, source_lyrics=source, target_lyrics=target,
                                 keyscale=KEYSCALE, bpm=BPM, n_min=0.0, n_max=0.7,
                                 seed=SEED, src_audio_rel=src_rel, src_tag="bhvoice-vocalcap")
    assert fe["params"]["caption"] == VOCAL_CAPTION
    assert fe["params"]["flow_edit_source_caption"] == VOCAL_CAPTION
    wav = run_worker(fe, "flowedit-vocalcap")
    subprocess.run(["ffmpeg", "-y", "-i", str(wav), str(SERVE / "voice-flowedit-vocalcap.wav")],
                   check=True, capture_output=True)
    print(f"render -> {SERVE / 'voice-flowedit-vocalcap.wav'}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
