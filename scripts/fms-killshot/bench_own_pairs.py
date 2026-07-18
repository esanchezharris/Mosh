#!/usr/bin/env python3
"""FMS-Bench own-voice pairs — the REAL (mumble → finished) trust anchor.

Every other bench lane synthesizes its mumble by degrading a clean vocal. This lane uses
the owner's *actual* rough-draft takes paired with the finished vocal he later recorded, so
the input carries real human rough-draft prosody — the one thing synthesis cannot fake.

Item shape extends the common one with a single additive field:

  {"id", "singer", "song", "clean_vocal", "mumble_vocal", "words", "license_tier", "train_ok"}
                                          ^^^^^^^^^^^^^ present ONLY on real-pair items

`clean_vocal` is the FINISHED take (the reference / ground truth); `mumble_vocal` is the
REAL mumble (the pipeline's input). The runner branches on `mumble_vocal`'s presence: NUS
items lack it and get a synthesized mumble at ratio rho, own-pairs items have one already —
the real-pairs lane is simply "rho = real".

DESIGN RULE (do not violate): melody/F0 and timing must be read from `mumble_vocal`, never
from `clean_vocal`. Here the finished take IS the answer; reading its F0 leaks it. (In the
NUS lane taking F0 from the clean vocal was sound, because there the clean vocal *was* the
source being degraded.)

Measured properties of this corpus (3 songs, ~2.6 min): naked vocals (sub-bass 0.5-2.3%),
both takes exported over the same Ableton span so they share a session clock (envelope
best-lag 0.000-0.035 s), finished takes transcribe at median Whisper confidence 0.78 while
the mumbles sit at 0.38. Licensing: the owner's own voice and lyrics => train-ok, unlike
the research-only NUS corpus. Audio lives OUTSIDE git.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

WHISPER_PY = os.path.expanduser("~/Library/Mosh/venvs/whisper/bin/python")
WHISPER_CLI = os.path.join(REPO, "service", "whisper", "whisper_cli.py")

AUDIO_EXT = {".aif", ".aiff", ".wav"}
FINISHED_ROLES = {"real", "finished", "final"}
MUMBLE_ROLES = {"mumble", "raw", "draft"}


# ── naming / pairing (pure) ─────────────────────────────────────────────────────────────

def classify(filename):
    """'<song> <role>.<ext>' -> (song, 'finished'|'mumble'|None).

    Role is the last space-separated token, case-insensitive, so song names may contain
    spaces. Non-audio extensions (notably Ableton's `.asd` analysis sidecars, which sit
    next to every exported take) are rejected outright."""
    base = os.path.basename(filename)
    stem, ext = os.path.splitext(base)
    if ext.lower() not in AUDIO_EXT:
        return (stem, None)
    parts = stem.rsplit(" ", 1)
    if len(parts) != 2:
        return (stem, None)
    song, tok = parts[0], parts[1].lower()
    if tok in FINISHED_ROLES:
        return (song, "finished")
    if tok in MUMBLE_ROLES:
        return (song, "mumble")
    return (stem, None)


def pair_files(names):
    """Group filenames into COMPLETE {song, mumble, finished} pairs, sorted by song.
    A song missing either take is dropped — a half-pair has no reference to score against."""
    by = {}
    for n in names:
        song, role = classify(n)
        if role:
            by.setdefault(song, {})[role] = n
    return [{"song": s, "mumble": by[s]["mumble"], "finished": by[s]["finished"]}
            for s in sorted(by) if "mumble" in by[s] and "finished" in by[s]]


def pair_item(song, mumble_wav, finished_wav, words, *, singer="owner"):
    """Normalized item. clean_vocal = the finished take (reference), mumble_vocal = the
    real draft (input). train-ok: the owner's own performance and lyrics."""
    return {"id": f"own-{song}", "singer": singer, "song": song, "language": "en",
            "clean_vocal": finished_wav, "mumble_vocal": mumble_wav,
            "license_tier": "train-ok", "train_ok": True, "words": words}


# ── ingest (impure) ─────────────────────────────────────────────────────────────────────

def convert_to_pcm16_mono(src, dst):
    """AIFF/WAV -> mono WAV PCM16 (fmt tag 1), the format `read_pcm_mono` and the forced
    aligner require. Level is NOT normalized: the relative loudness between a pair's two
    takes is signal, and normalizing would destroy the energy comparison."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(src, always_2d=True)
    mono = x.mean(axis=1)
    sf.write(dst, mono, sr, subtype="PCM_16")
    return {"path": dst, "sr": sr, "dur": len(mono) / float(sr),
            "peak": float(np.abs(mono).max()) if len(mono) else 0.0}


def transcribe_words(wav, *, model="small"):
    """Ground-truth words from the FINISHED take via Whisper (its own venv, subprocess).
    Validated on this corpus at median confidence 0.78 — the mumble reads 0.38, which is
    exactly why the reference, never the draft, is the word source."""
    r = subprocess.run([WHISPER_PY, WHISPER_CLI, wav, model],
                       capture_output=True, text=True)
    try:
        d = json.loads(r.stdout)
    except Exception:
        raise RuntimeError(f"whisper produced no JSON: {(r.stderr or '')[-300:]}")
    if not d.get("ok"):
        raise RuntimeError(f"whisper failed: {d.get('error')}")
    return d.get("words", [])


def ingest(src_dir, out_dir, *, model="small", force=False):
    """Convert every complete pair under src_dir into out_dir and cache ground-truth words.
    Idempotent: existing outputs are reused unless force=True (Whisper is the slow step)."""
    os.makedirs(out_dir, exist_ok=True)
    report = []
    for p in pair_files(os.listdir(src_dir)):
        song = p["song"]
        row = {"song": song}
        for role in ("mumble", "finished"):
            dst = os.path.join(out_dir, f"{song}.{role}.wav")
            if force or not os.path.isfile(dst):
                row[role] = convert_to_pcm16_mono(os.path.join(src_dir, p[role]), dst)
            else:
                row[role] = {"path": dst, "cached": True}
        wj = os.path.join(out_dir, f"{song}.words.json")
        if force or not os.path.isfile(wj):
            words = transcribe_words(os.path.join(out_dir, f"{song}.finished.wav"), model=model)
            json.dump(words, open(wj, "w"), indent=1)
        else:
            words = json.load(open(wj))
        row["n_words"] = len(words)
        report.append(row)
    return report


def own_pairs_items(root=None, *, songs=None, limit=None):
    """Enumerate ingested pairs under root -> normalized items."""
    import bench_dataset as bd
    root = root or bd.REGISTRY["own-pairs"]["default_root"]
    out = []
    for f in sorted(os.listdir(root)):
        if not f.endswith(".finished.wav"):
            continue
        song = f[: -len(".finished.wav")]
        if songs and song not in songs:
            continue
        mum = os.path.join(root, f"{song}.mumble.wav")
        wj = os.path.join(root, f"{song}.words.json")
        if not (os.path.isfile(mum) and os.path.isfile(wj)):
            continue
        out.append(pair_item(song, mum, os.path.join(root, f), json.load(open(wj))))
        if limit and len(out) >= limit:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.expanduser("~/Downloads"))
    ap.add_argument("--out", default=None, help="default: the own-pairs registry root")
    ap.add_argument("--model", default="small")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    import bench_dataset as bd
    out = a.out or bd.REGISTRY["own-pairs"]["default_root"]
    for row in ingest(a.src, out, model=a.model, force=a.force):
        print(f"  {row['song']:14} words={row['n_words']:4d}  "
              f"mumble={row['mumble'].get('dur', '·')}  finished={row['finished'].get('dur', '·')}")
    items = own_pairs_items(out)
    print(f"\n{len(items)} items -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
