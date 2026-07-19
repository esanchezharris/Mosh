#!/usr/bin/env python3
"""Install owner-corrected lyrics as bench ground truth.

The corrections from `bench_lyric_edit` are line-level text; the bench needs per-WORD
timings on the take's clock. This tokenizes the corrected lines, forced-aligns them to
the finished vocal (MMS_FA via align_probe, the singing-capable ruler — Whisper cannot
time sustained singing), reports alignment quality honestly, and — only when asked —
installs `<song>.words.json` + `<song>.lyrics.txt`, backing up the originals first.

Pure cores (golden-tested): tokenize_lines, merge_alignment, alignment_report, install.

  bench_lyric_install.py --report            # align + print quality, change nothing
  bench_lyric_install.py --install           # align + install (backs up originals)
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATASET = os.path.expanduser("~/mosh-fms-ksb/bench/datasets/own-pairs")
SONGS = ("LookinBack", "stage9orsum", "stage10")
SKELETON_PY = os.path.expanduser(
    os.environ.get("SKELETON_PY", "~/Library/Mosh/venvs/skeleton/bin/python3"))
HIT = 0.3
_WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)


# ── pure cores ──────────────────────────────────────────────────────────────────────────

def tokenize_lines(lines):
    """Corrected lines -> the word tokens the aligner will be asked for.

    Punctuation and dashes are dropped; apostrophes and accents are KEPT inside words
    (don't / piñata stay single words — the phoneme layer folds accents itself).
    Parenthetical ad-libs are kept: they are sung, so the aligner must account for them."""
    out = []
    for i, ln in enumerate(lines):
        text = str(ln.get("text", "") or "")
        for m in _WORD_RE.finditer(text):
            out.append({"word": m.group(0).replace("’", "'"), "line": i,
                        "lineT": round(float(ln.get("t", 0.0)), 2)})
    return out


def merge_alignment(tokens, aligned):
    """Zip tokens with their aligner spans -> bench word rows. None on any count
    mismatch — a silent truncation would ship a lyric the take never sings."""
    if len(tokens) != len(aligned):
        return None
    out = []
    for tok, al in zip(tokens, aligned):
        out.append({"word": tok["word"], "start": round(float(al["start"]), 3),
                    "end": round(float(al["end"]), 3),
                    "score": round(float(al.get("score", 0.0)), 3),
                    "line": tok["line"]})
    return out


def alignment_report(words, hit=HIT):
    """Honest quality read: how many words the aligner is unsure about, and where."""
    if not words:
        return {"n": 0, "low": 0, "lowWords": [], "span": [0.0, 0.0], "meanScore": 0.0}
    low = [w for w in words if float(w.get("score", 0.0)) < hit]
    return {"n": len(words), "low": len(low),
            "lowWords": [w["word"] for w in low],
            "lowFrac": round(len(low) / len(words), 3),
            "span": [min(w["start"] for w in words), max(w["end"] for w in words)],
            "meanScore": round(sum(float(w.get("score", 0.0)) for w in words) / len(words), 3)}


def install(song, words, lines, dataset):
    """Write the new ground truth; back up the originals ONCE (a second install must not
    overwrite the backup — that copy is the only record of the pre-correction truth)."""
    paths = {"words": os.path.join(dataset, f"{song}.words.json"),
             "lyrics": os.path.join(dataset, f"{song}.lyrics.txt"),
             "backupWords": os.path.join(dataset, f"{song}.words.orig.json"),
             "backupLyrics": os.path.join(dataset, f"{song}.lyrics.orig.txt")}
    for src, bak in (("words", "backupWords"), ("lyrics", "backupLyrics")):
        if os.path.isfile(paths[src]) and not os.path.isfile(paths[bak]):
            shutil.copyfile(paths[src], paths[bak])
    json.dump([{k: w[k] for k in ("word", "start", "end", "score", "line")} for w in words],
              open(paths["words"], "w"), indent=1, ensure_ascii=False)
    body = "\n".join(str(ln["text"]).strip() for ln in lines if str(ln["text"]).strip())
    open(paths["lyrics"], "w").write(body + "\n")
    return paths


# ── alignment (impure: skeleton venv + MMS_FA) ─────────────────────────────────────────

def align(wav, tokens):
    with tempfile.TemporaryDirectory() as td:
        wj = os.path.join(td, "words.json")
        json.dump([t["word"] for t in tokens], open(wj, "w"), ensure_ascii=False)
        r = subprocess.run([SKELETON_PY, os.path.join(HERE, "align_probe.py"), wav, wj],
                           capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"align failed: {r.stderr[-400:]}")
    out = json.loads(r.stdout)
    if not out.get("ok"):
        raise RuntimeError(f"align not ok: {out}")
    return out["words"]


def run(dataset, songs, do_install):
    draft = os.path.join(dataset, "asr-draft")
    results = {}
    for song in songs:
        cj = os.path.join(draft, f"{song}.corrected.json")
        wav = os.path.join(dataset, f"{song}.finished.wav")
        if not os.path.isfile(cj):
            print(f"{song}: no corrections — skipped")
            continue
        lines = json.load(open(cj))["lines"]
        tokens = tokenize_lines(lines)
        aligned = align(wav, tokens)
        words = merge_alignment(tokens, aligned)
        if words is None:
            print(f"{song}: ALIGNER RETURNED {len(aligned)} spans for {len(tokens)} words "
                  f"— refusing to install")
            continue
        rep = alignment_report(words)
        results[song] = {"report": rep, "words": len(words)}
        print(f"{song}: {rep['n']} words, span {rep['span'][0]:.1f}-{rep['span'][1]:.1f}s, "
              f"mean score {rep['meanScore']}, low-confidence {rep['low']} "
              f"({rep['lowFrac']:.0%}){' -> ' + ', '.join(rep['lowWords'][:8]) if rep['low'] else ''}")
        if do_install:
            p = install(song, words, lines, dataset)
            print(f"   installed {os.path.basename(p['words'])} "
                  f"(originals backed up as *.orig.*)")
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--songs", default=None)
    ap.add_argument("--install", action="store_true",
                    help="write the new ground truth (default: report only)")
    a = ap.parse_args()
    songs = [s for s in (a.songs or "").split(",") if s] or list(SONGS)
    run(a.dataset, songs, a.install)
    return 0


if __name__ == "__main__":
    sys.exit(main())
