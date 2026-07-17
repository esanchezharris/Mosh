#!/usr/bin/env python3
"""Forced-alignment probe (mechanism-verify V0) — align KNOWN words to a wav (or a slice
of it) via skeleton.align.align_words (MMS_FA), emitting per-word spans as JSON. The slice
option lets a caller align long assembled renders window-by-window without shipping audio
through argv.

Run under the skeleton venv:
  ~/Library/Mosh/venvs/skeleton/bin/python3 align_probe.py <in.wav> <words.json> [--t0 S --t1 S]

words.json = ["word", ...]. Output times are SLICE-LOCAL (caller shifts by --t0):
  {"ok": true, "words": [{"word":..., "start":..., "end":..., "score":...}, ...]}
"""
import argparse
import json
import os
import sys

_OUT = sys.stdout
sys.stdout = sys.stderr

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("words_json")
    ap.add_argument("--t0", type=float, default=None)
    ap.add_argument("--t1", type=float, default=None)
    args = ap.parse_args()

    from skeleton import align as skalign
    from skeleton import core as skcore

    with open(args.words_json) as f:
        words = json.load(f)
    r = skcore.read_pcm_mono(args.wav)
    if not r:
        _OUT.write(json.dumps({"ok": False, "error": f"not stdlib-readable: {args.wav}"}))
        return 1
    mono, sr = r
    if args.t0 is not None or args.t1 is not None:
        a = int((args.t0 or 0.0) * sr)
        b = int(args.t1 * sr) if args.t1 is not None else len(mono)
        mono = mono[a:b]
    res = skalign.align_words((mono, sr), words)
    if res is None:
        _OUT.write(json.dumps({"ok": False, "error": "align_words unavailable/empty"}))
        return 1
    _OUT.write(json.dumps({"ok": True, "words": res}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
