#!/usr/bin/env python3
"""score_vocal(reference, generated) -> {correctness, naturalness, meta}.

FMS-Bench, increment 1. A thin adapter over the existing lab:
  - overlap.analyze() carries the whole CORRECTNESS bundle (lag, onset F1, F0 register,
    silence leakage, phrases) — point original=reference/clean, render=generated;
  - naturalness() scores the GENERATED alone (human-likeness, not distance);
  - word_match is against the dataset's TRUE words (ground truth), not the score's words.

`deps` injects the lab back-ends ({read, f0, analyze, naturalness, asr}) so tests run with
zero audio/venvs. Defaults wire the real lab (F0 via the nsf pyin probe, ASR via whisper).
"""
from __future__ import annotations

import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)


def _write_wav_mono(mono, sr, path):
    w = wave.open(path, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(sr)
    w.writeframes(b"".join(struct.pack("<h", int(max(-32767, min(32767, x * 32767)))) for x in mono))
    w.close()


def _real_deps():
    import diagnose
    import overlap

    def read(path):
        with tempfile.TemporaryDirectory() as td:
            mono, sr, _wav = overlap._read_mono(path, td)
        return mono, sr

    def f0(mono, sr):
        # dense pyin voicing/F0 via the nsf venv probe (as overlap.main does)
        py = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))
        probe = os.path.join(HERE, "pyin_probe.py")
        if not (os.path.isfile(py) and os.path.isfile(probe)):
            return None
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            _write_wav_mono(mono, sr, tmp)
            r = diagnose._run_json(py, probe, tmp)
        finally:
            os.remove(tmp)
        return [{"t": t, "hz": hz} for t, hz, _v in r.get("frames", [])] if r.get("ok") else None

    def asr(wav):
        wp = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")
        if not wp:
            return None
        cli = os.path.join(REPO, "service/whisper/whisper_cli.py")
        r = diagnose._run_json(wp, cli, wav, "small")
        return [w.get("word", "").strip() for w in r.get("words", [])] if r.get("ok") else None

    import bench_naturalness
    return {"read": read, "f0": f0, "analyze": overlap.analyze,
            "naturalness": bench_naturalness.naturalness, "asr": asr}


def score_vocal(reference_wav, generated_wav, *, score_clip=None, true_words=None, deps=None):
    d = deps or _real_deps()
    ref, sr_r = d["read"](reference_wav)
    gen, sr_g = d["read"](generated_wav)
    f0_ref = d["f0"](ref, sr_r)
    f0_gen = d["f0"](gen, sr_g)
    correctness = dict(d["analyze"](ref, sr_r, gen, sr_g, f0_ref, f0_gen, score_clip))
    if true_words:
        import overlap
        aw = d["asr"](generated_wav)
        if aw is not None:
            correctness["words"] = overlap.word_match(true_words, aw)
    return {"correctness": correctness,
            "naturalness": d["naturalness"](generated_wav),
            "meta": {"reference": os.path.basename(reference_wav),
                     "generated": os.path.basename(generated_wav),
                     "sr": {"reference": sr_r, "generated": sr_g}}}
