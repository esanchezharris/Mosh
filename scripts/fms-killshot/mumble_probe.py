#!/usr/bin/env python3
"""Measure whether a synthetic mumble is REALISTIC: does ASR confidence drop on the
degraded words while F0 + energy-envelope are preserved on those spans?

A good mumble synthesizer destroys phonetic/consonant identity (ASR can't read the word)
but keeps the pitch and the rhythm the singer intended (stressed vowels + energy survive).
This probe is the shared ruler the degradation-method design panel is judged by, and it is
the mumble synthesizer's self-consistency check.

Outputs JSON:
  asr:    {degraded_conf, kept_conf, conf_drop}   (drop = baseline − degraded on mumbled spans; HIGHER better)
  f0:     {median_dsemi, within_half, voiced_kept} (pitch preserved on spans; median_dsemi LOWER better)
  energy: {corr}                                    (RMS-envelope Pearson on spans; HIGHER better)

Usage:
  mumble_probe.py --clean CLEAN.wav --degraded DEG.wav --spans SPANS.json
                  --baseline BASELINE_WORDS.json [--out OUT.json]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

import diagnose  # noqa: E402
from skeleton import core as skcore  # noqa: E402


def _read_mono(path):
    with tempfile.TemporaryDirectory() as td:
        wav = diagnose._to_wav(os.path.abspath(path), td)
        r = skcore.read_pcm_mono(wav)
        if r:
            return r[0], r[1]
        mono, sr = diagnose._read_wav_mono(wav)
        return mono, sr


def _pyin(mono, sr):
    """[{t,hz,voiced}] via the nsf pyin probe, or [] if the venv/probe is absent."""
    py = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))
    probe = os.path.join(HERE, "pyin_probe.py")
    if not (os.path.isfile(py) and os.path.isfile(probe)):
        return []
    fd, tmp = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        w = wave.open(tmp, "wb")
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(max(-32767, min(32767, x * 32767)))) for x in mono))
        w.close()
        r = diagnose._run_json(py, probe, tmp)
    finally:
        os.remove(tmp)
    return [{"t": t, "hz": hz, "v": bool(v)} for t, hz, v in r.get("frames", [])] if r.get("ok") else []


def _whisper(path):
    wp = diagnose._venv_python("whisper/.whisper.env", "WHISPER_PY")
    if not wp:
        wp = os.path.expanduser("~/Library/Mosh/venvs/whisper/bin/python3")
        if not os.path.isfile(wp):
            return []
    cli = os.path.join(REPO, "service/whisper/whisper_cli.py")
    r = diagnose._run_json(wp, cli, path, "small")
    return r.get("words", []) if r.get("ok") else []


def _in_spans(t0, t1, spans):
    return any(t0 < e and t1 > s for s, e in spans)


def _mean(xs):
    return sum(xs) / len(xs) if xs else None


def measure(clean_wav, degraded_wav, spans, baseline_words):
    clean, sr_c = _read_mono(clean_wav)
    deg, sr_d = _read_mono(degraded_wav)

    # ── ASR: confidence on degraded vs kept regions of the DEGRADED transcript ──
    dwords = _whisper(degraded_wav)
    deg_conf = [float(w.get("confidence", 0)) for w in dwords
                if _in_spans(float(w["start"]), float(w["end"]), spans)]
    kept_conf = [float(w.get("confidence", 0)) for w in dwords
                 if not _in_spans(float(w["start"]), float(w["end"]), spans)]
    base_deg_conf = [float(w.get("confidence", 0)) for w in baseline_words
                     if _in_spans(float(w["start"]), float(w["end"]), spans)]
    # if a mumbled span produced NO word in the degraded transcript, that is max success:
    deg_conf_val = _mean(deg_conf) if deg_conf else 0.0
    asr = {"degraded_conf": round(deg_conf_val, 3),
           "kept_conf": round(_mean(kept_conf), 3) if kept_conf else None,
           "baseline_conf": round(_mean(base_deg_conf), 3) if base_deg_conf else None,
           "conf_drop": round((_mean(base_deg_conf) if base_deg_conf else 0.0) - deg_conf_val, 3)}

    # ── F0 preservation on the degraded spans (voiced in both) ──
    fc, fd = _pyin(clean, sr_c), _pyin(deg, sr_d)
    mc = {round(p["t"], 2): p["hz"] for p in fc if p["v"] and p["hz"] > 0 and _in_spans(p["t"], p["t"], spans)}
    md = {round(p["t"], 2): p["hz"] for p in fd if p["v"] and p["hz"] > 0}
    dsemi, voiced_both, voiced_clean = [], 0, len(mc)
    for t, hz_c in mc.items():
        hz_d = md.get(t)
        if hz_d:
            voiced_both += 1
            dsemi.append(abs(12.0 * math.log2(hz_d / hz_c)))
    dsemi.sort()
    f0 = {"median_dsemi": round(dsemi[len(dsemi) // 2], 2) if dsemi else None,
          "within_half": round(sum(1 for d in dsemi if d <= 0.5) / len(dsemi), 3) if dsemi else None,
          "voiced_kept": round(voiced_both / voiced_clean, 3) if voiced_clean else None}

    # ── energy-envelope preservation on the degraded spans ──
    ec = skcore.energy_envelope(clean, sr_c)
    ed = skcore.energy_envelope(deg, sr_d)
    hop = skcore.HOP_MS / 1000.0
    idx = [i for i in range(min(len(ec), len(ed))) if _in_spans(i * hop, i * hop, spans)]
    a = [ec[i] for i in idx]
    b = [ed[i] for i in idx]
    energy = {"corr": _pearson(a, b)}
    return {"asr": asr, "f0": f0, "energy": energy,
            "spans": len(spans), "degraded_words": len(deg_conf)}


def _pearson(a, b):
    n = min(len(a), len(b))
    if n < 3:
        return None
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    da = [x - ma for x in a]
    db = [x - mb for x in b]
    na = math.sqrt(sum(x * x for x in da))
    nb = math.sqrt(sum(x * x for x in db))
    if na == 0 or nb == 0:
        return None
    return round(sum(x * y for x, y in zip(da, db)) / (na * nb), 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clean", required=True)
    ap.add_argument("--degraded", required=True)
    ap.add_argument("--spans", required=True, help="JSON list of [start_s, end_s]")
    ap.add_argument("--baseline", required=True, help="baseline words JSON (clean transcript)")
    ap.add_argument("--out")
    a = ap.parse_args()
    spans = [tuple(s) for s in json.load(open(a.spans))]
    baseline = json.load(open(a.baseline)).get("words", [])
    res = measure(a.clean, a.degraded, spans, baseline)
    print(json.dumps(res, indent=1, sort_keys=True))
    if a.out:
        json.dump(res, open(a.out, "w"), indent=1, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
