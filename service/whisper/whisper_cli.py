#!/usr/bin/env python3
"""Word-level speech transcription via OpenAI Whisper (MIT).

Runs UNDER the dedicated whisper venv (~/Library/Mosh/venvs/whisper), invoked by
service/server.py's /transcribe_words endpoint as a subprocess, so Whisper's deps
(torch/numba/tiktoken) never touch the service interpreter. Emits a JSON word list to
stdout (times in SECONDS, with per-word confidence — the "mumble take" flow keeps only
high-confidence words as lyric anchors):

  {"ok": true, "words": [{"word": str, "start": float, "end": float, "confidence": float}, ...]}

Usage:  whisper_cli.py <input-audio> [model]      (model defaults to "base")
"""
import json
import sys

# Whisper + its runtime print progress/warnings to STDOUT/stderr. Capture the REAL stdout
# up front and route library noise to stderr, so stdout carries ONLY our JSON result.
_OUT = sys.stdout
sys.stdout = sys.stderr


def _emit_fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def main() -> "None":
    if len(sys.argv) < 2:
        _emit_fail("usage: whisper_cli.py <input-audio> [model]")
    audio_path = sys.argv[1]
    model_name = sys.argv[2].strip() if len(sys.argv) > 2 and sys.argv[2].strip() else "base"

    try:
        import whisper
    except Exception as e:  # noqa: BLE001 — surface any import failure as JSON
        _emit_fail(f"whisper not importable: {e}")

    try:
        model = whisper.load_model(model_name)   # lazy-downloads on first use
        # word_timestamps=True yields per-word start/end + a per-word probability we use as
        # the confidence the mumble-take gate filters on. English-biased; fp16 off for CPU.
        result = model.transcribe(audio_path, word_timestamps=True, language="en", fp16=False)
    except Exception as e:  # noqa: BLE001
        _emit_fail(f"transcription failed: {e}")

    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            txt = str(w.get("word", "")).strip()
            if not txt:
                continue
            words.append({
                "word": txt,
                "start": float(w.get("start", 0.0)),
                "end": float(w.get("end", 0.0)),
                "confidence": float(w.get("probability", 0.0)),
            })

    _OUT.write(json.dumps({"ok": True, "words": words}))


if __name__ == "__main__":
    main()
