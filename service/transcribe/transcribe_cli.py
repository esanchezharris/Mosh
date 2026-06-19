#!/usr/bin/env python3
"""Audio -> MIDI note transcription via Spotify Basic Pitch (Apache-2.0).

Runs UNDER the dedicated transcribe venv (service/transcribe/.venv), invoked by
service/server.py's /transcribe endpoint as a subprocess, so Basic Pitch's deps
(CoreML/numpy/librosa) never touch the service interpreter. Emits a JSON note list
to stdout (times in SECONDS; the native side converts to beats):

  {"ok": true, "notes": [{"pitch": int, "start": float, "end": float, "velocity": 1..127}, ...]}

Basic Pitch is one (inherently polyphonic) model; the two presets are just params:
  mono  — sung single-lines: instrument/vocal range + melodia_trick, then a
          MONOPHONIC COLLAPSE so the output is one clean voice (no overlaps).
  poly  — chords / polyphonic instruments: Basic Pitch defaults.

Usage:  transcribe_cli.py <input-audio> <mono|poly>
"""
import json
import sys

# Basic Pitch (and the CoreML runtime) print progress chatter to STDOUT
# ("Predicting MIDI…", "shape:…"). Capture the REAL stdout up front and route all
# library noise to stderr, so stdout carries ONLY our JSON result for the service.
_OUT = sys.stdout
sys.stdout = sys.stderr


def _emit_fail(msg: str) -> "None":
    _OUT.write(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _monophonic(notes: list) -> list:
    """Collapse to a single voice: at any instant only one note sounds. On overlap,
    keep the louder note and trim the earlier note's tail to the later onset; drop a
    fragment shorter than 30 ms. Input must be sorted by (start, -velocity)."""
    MIN = 0.03
    out: list = []
    for n in notes:
        if out and n["start"] < out[-1]["end"]:
            prev = out[-1]
            if n["velocity"] > prev["velocity"]:
                prev["end"] = n["start"]
                if prev["end"] - prev["start"] < MIN:
                    out.pop()
                out.append(dict(n))
            else:
                n = dict(n)
                n["start"] = prev["end"]
                if n["end"] - n["start"] >= MIN:
                    out.append(n)
        else:
            out.append(dict(n))
    return out


def main() -> "None":
    if len(sys.argv) < 3:
        _emit_fail("usage: transcribe_cli.py <input-audio> <mono|poly>")
    audio_path, mode = sys.argv[1], sys.argv[2].strip().lower()
    if mode not in ("mono", "poly"):
        mode = "mono"

    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except Exception as e:  # noqa: BLE001 — surface any import/runtime failure as JSON
        _emit_fail(f"basic-pitch not importable: {e}")

    if mode == "mono":
        kwargs = dict(
            onset_threshold=0.6,
            frame_threshold=0.3,
            minimum_note_length=90.0,        # ms — sung notes are rarely shorter
            minimum_frequency=65.0,          # ~C2: drop sub-bass rumble
            maximum_frequency=1200.0,        # ~D6: a generous vocal/lead ceiling
            multiple_pitch_bends=False,
            melodia_trick=True,
        )
    else:  # poly — let Basic Pitch use its defaults for note length + full range
        kwargs = dict(
            onset_threshold=0.5,
            frame_threshold=0.3,
            multiple_pitch_bends=False,
            melodia_trick=True,
        )

    try:
        _model_output, _midi, note_events = predict(audio_path, ICASSP_2022_MODEL_PATH, **kwargs)
    except Exception as e:  # noqa: BLE001
        _emit_fail(f"transcription failed: {e}")

    # note_events: (start_s, end_s, pitch_midi, amplitude 0..1, pitch_bend | None)
    notes = []
    for ev in note_events:
        start_s, end_s, pitch, amp = float(ev[0]), float(ev[1]), int(ev[2]), float(ev[3])
        if end_s <= start_s:
            continue
        vel = max(1, min(127, int(round(amp * 126)) + 1))
        notes.append({"pitch": pitch, "start": start_s, "end": end_s, "velocity": vel})

    notes.sort(key=lambda n: (n["start"], -n["velocity"]))
    if mode == "mono":
        notes = _monophonic(notes)

    _OUT.write(json.dumps({"ok": True, "notes": notes}))


if __name__ == "__main__":
    main()
