#!/usr/bin/env python3
"""Take-calibrated ASR word gate — the word campaign's loop instrument.

Contract (registered: docs/superpowers/specs/2026-07-18-fms-word-campaign-design.md):

  1. The TAKE's whisper transcript is aligned to the known lyric (fuzzy, monotonic).
     Lyric words the take yields = the DEMAND SET, with take timestamps.
  2. Each demanded word must appear in the RENDER transcript (fuzzy, within
     LOCALIZE_S of the take position) -> else `missing`.
  3. Lyric words the take does NOT yield (whisper can't read them even from the human
     take, e.g. pinata -> "pin yet") are adjudicated by SYLLABLE COUNT in their anchor
     gap: the take-heard syllables there are the calibrated demand; fewer render-heard
     syllables -> `sylDeficit`. A gap where the take heard nothing is unsupported.
  4. GATE PASS = no missing and no sylDeficits.

Whisper (model `small`, dedicated venv) stays at the CLI boundary; every matching core
is pure and golden-tested (bench_words_gate_test.py). ASR runs the loop; the owner's
milestone listen is still the only real pass.

CLI:
  bench_words_gate.py --run <round-dir> [--arm pipeline] [--dataset <own-pairs>]
                      [--out <json>] [--songs a,b] [--no-cache]
"""
import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(HERE)), "service"))
from phonology.core import fold_diacritics, heuristic_syllables  # noqa: E402

MODEL = "small"
LOCALIZE_S = 1.5          # a demanded word must land within this of the take position
GAP_PAD_S = 0.35          # render search margin around an anchor gap
SHORT_EXACT_LEN = 2       # words this short (normalized) must match exactly
DEFAULT_DATASET = os.path.expanduser("~/mosh-fms-ksb/bench/datasets/own-pairs")
CACHE_DIR = os.path.expanduser("~/mosh-fms-ksb/bench/cache/asr")
WHISPER_PY = os.environ.get(
    "MOSH_WHISPER_PY", os.path.expanduser("~/Library/Mosh/venvs/whisper/bin/python"))
WHISPER_CLI = os.path.join(os.path.dirname(os.path.dirname(HERE)),
                           "service", "whisper", "whisper_cli.py")

_CONTRACTIONS = ("'ve", "'s", "'ll", "'d", "'m", "'re")


# ── pure cores ──────────────────────────────────────────────────────────────────────────

def norm_word(w: str) -> str:
    """Casefold, fold diacritics, strip punctuation, drop contraction suffixes."""
    s = fold_diacritics(str(w)).casefold().replace("’", "'")
    s = re.sub(r"[^a-z']", "", s)
    for suf in _CONTRACTIONS:
        if s.endswith(suf) and len(s) > len(suf):
            s = s[: -len(suf)]
            break
    return s.replace("'", "")


def edit_distance(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def fuzzy(a: str, b: str) -> bool:
    na, nb = norm_word(a), norm_word(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if min(len(na), len(nb)) <= SHORT_EXACT_LEN:
        return False
    return edit_distance(na, nb) <= 1


def _syl(word: str) -> int:
    return max(1, heuristic_syllables(re.sub(r"[^a-z]", "", norm_word(word)) or "a"))


def align_lyric(lyric_words, take_words):
    """Monotonic fuzzy alignment (LCS) of the lyric to the take transcript.

    Returns [(lyric_idx, take_idx), ...] in order.
    """
    n, m = len(lyric_words), len(take_words)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if fuzzy(lyric_words[i - 1], take_words[j - 1]["word"]):
                dp[i][j] = dp[i - 1][j - 1] + 1
            if dp[i - 1][j] > dp[i][j]:
                dp[i][j] = dp[i - 1][j]
            if dp[i][j - 1] > dp[i][j]:
                dp[i][j] = dp[i][j - 1]
    out = []
    i, j = n, m
    while i > 0 and j > 0:
        if (fuzzy(lyric_words[i - 1], take_words[j - 1]["word"])
                and dp[i][j] == dp[i - 1][j - 1] + 1):
            out.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif dp[i - 1][j] >= dp[i][j - 1]:
            i -= 1
        else:
            j -= 1
    return list(reversed(out))


def demand_and_gaps(lyric_words, take_words, span):
    """The demand set (anchored words) + anchor gaps carrying unmatched lyric words."""
    anchors = align_lyric(lyric_words, take_words)
    demands = [{"word": lyric_words[i], "t": float(take_words[j]["start"]),
                "conf": float(take_words[j].get("confidence") or 0.0)}
               for i, j in anchors]
    gaps = []
    bounds = [(-1, None)] + list(anchors) + [(len(lyric_words), None)]
    for (i0, j0), (i1, j1) in zip(bounds[:-1], bounds[1:]):
        missing_lyric = lyric_words[i0 + 1:i1]
        if not missing_lyric:
            continue
        t0 = float(take_words[j0]["end"]) if j0 is not None else float(span[0])
        t1 = float(take_words[j1]["start"]) if j1 is not None else float(span[1])
        lo = j0 + 1 if j0 is not None else 0
        hi = j1 if j1 is not None else len(take_words)
        heard = take_words[lo:hi]
        if not heard:
            continue                      # the take never voiced these words: unsupported
        take_syl = sum(_syl(w["word"]) for w in heard)
        lyric_syl = sum(_syl(w) for w in missing_lyric)
        # registered refinement (2026-07-19): demand the WORD's syllables, floored by
        # what the take demonstrates — never the take's ornament count (melisma pulses
        # are not lexical content; "lacoste" needs 2, not the take's 9)
        gaps.append({"lyricWords": list(missing_lyric), "t0": t0, "t1": t1,
                     "takeWords": [dict(w) for w in heard],
                     "takeSyl": take_syl, "lyricSyl": lyric_syl,
                     "demandSyl": min(take_syl, lyric_syl)})
    return demands, gaps


def gate_song(lyric_words, take_words, render_words, span,
              localize_s=LOCALIZE_S, gap_pad_s=GAP_PAD_S):
    demands, gaps = demand_and_gaps(lyric_words, take_words, span)

    claimed = set()
    missing = []
    hits = 0
    for d in demands:
        cands = [(abs(float(rw["start"]) - d["t"]), k)
                 for k, rw in enumerate(render_words)
                 if k not in claimed and fuzzy(d["word"], rw["word"])
                 and abs(float(rw["start"]) - d["t"]) <= localize_s]
        if cands:
            claimed.add(min(cands)[1])
            hits += 1
        else:
            near = [rw["word"].strip() for rw in render_words
                    if abs(float(rw["start"]) - d["t"]) <= localize_s]
            missing.append({"word": d["word"], "t": round(d["t"], 3),
                            "renderHeard": " ".join(near)})

    deficits = []
    for g in gaps:
        win = [(k, rw) for k, rw in enumerate(render_words)
               if k not in claimed
               and g["t0"] - gap_pad_s <= float(rw["start"]) <= g["t1"] + gap_pad_s]
        rsyl = sum(_syl(rw["word"]) for _, rw in win)
        if rsyl < g["demandSyl"]:
            deficits.append({"lyricWords": g["lyricWords"],
                             "t0": round(g["t0"], 3), "t1": round(g["t1"], 3),
                             "takeSyl": g["takeSyl"], "demandSyl": g["demandSyl"],
                             "renderSyl": rsyl,
                             "takeHeard": " ".join(w["word"].strip() for w in g["takeWords"]),
                             "renderHeard": " ".join(rw["word"].strip() for _, rw in win)})

    return {"lyricWords": len(lyric_words), "demanded": len(demands), "hits": hits,
            "hitRate": round(hits / len(demands), 4) if demands else 1.0,
            "missing": missing, "sylDeficits": deficits,
            "gaps": len(gaps), "pass": not missing and not deficits}


# ── whisper boundary (impure; cached by content hash) ───────────────────────────────────

def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def transcribe(wav, cache=True):
    key = os.path.join(CACHE_DIR, f"{_sha(wav)}.{MODEL}.json")
    if cache and os.path.exists(key):
        return json.load(open(key))
    r = subprocess.run([WHISPER_PY, WHISPER_CLI, wav, MODEL],
                       capture_output=True, text=True, timeout=1800)
    out = json.loads(r.stdout)
    if not out.get("ok"):
        raise RuntimeError(f"whisper failed on {wav}: {out.get('error')}")
    words = out["words"]
    if cache:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(key, "w") as f:
            json.dump(words, f)
    return words


def _wav_dur(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def gate_run(run_dir, arm="pipeline", dataset=DEFAULT_DATASET, songs=None, cache=True):
    report = {"runDir": run_dir, "arm": arm, "model": MODEL, "songs": {}}
    refs = sorted(glob.glob(os.path.join(run_dir, "*_reference.wav")))
    for ref in refs:
        base = os.path.basename(ref)[: -len("_reference.wav")]
        song = base.rsplit("_", 1)[0]
        if songs and song not in songs:
            continue
        rend = os.path.join(run_dir, f"{base}_{arm}.wav")
        lyr = os.path.join(dataset, f"{song}.lyrics.txt")
        if not (os.path.exists(rend) and os.path.exists(lyr)):
            report["songs"][song] = {"error": f"missing {rend if not os.path.exists(rend) else lyr}"}
            continue
        lyric_words = open(lyr).read().split()
        span = (0.0, _wav_dur(ref))
        rep = gate_song(lyric_words, transcribe(ref, cache), transcribe(rend, cache), span)
        report["songs"][song] = rep
    oks = [s for s in report["songs"].values() if "error" not in s]
    report["pass"] = bool(oks) and all(s["pass"] for s in oks)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--arm", default="pipeline")
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--out", default=None)
    ap.add_argument("--songs", default=None, help="comma list")
    ap.add_argument("--no-cache", action="store_true")
    a = ap.parse_args()
    songs = [s for s in (a.songs or "").split(",") if s] or None
    rep = gate_run(a.run, arm=a.arm, dataset=a.dataset, songs=songs, cache=not a.no_cache)
    out = a.out or os.path.join(a.run, "words_gate.json")
    with open(out, "w") as f:
        json.dump(rep, f, indent=1)
    for song, s in sorted(rep["songs"].items()):
        if "error" in s:
            print(f"{song}: ERROR {s['error']}")
            continue
        print(f"{song}: {'PASS' if s['pass'] else 'FAIL'} hit {s['hits']}/{s['demanded']}"
              f" missing={[m['word'] for m in s['missing']]}"
              f" sylDeficits={[d['lyricWords'] for d in s['sylDeficits']]}")
    print(f"GATE: {'GREEN' if rep['pass'] else 'RED'}  -> {out}")


if __name__ == "__main__":
    main()
