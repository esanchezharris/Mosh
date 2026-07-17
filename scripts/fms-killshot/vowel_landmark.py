#!/usr/bin/env python3
"""V0 of the mechanism-verify spec (docs/superpowers/specs/2026-07-16-fms-mechanism-verify-design.md):
measure the VOWEL-landmark blind spot on the existing Used2 renders — no new renders.

Registered hypothesis: stage 3 transfers mumble-slot durations verbatim, stage 5 aligns word
STARTS, but the perceptual beat is the VOWEL onset — so rendered vowels land LATE and/or get
SQUEEZED by ~the onset-consonant-cluster duration, invisibly to the shipped ~9ms word-snap
metric (it measures word starts, the wrong landmark).

Per word instance (from the score's own note chain): render vowel onset + vowel duration vs
the take's, bucketed by onset-cluster length. Clean subset = ALL-VOICELESS onsets
({S,T,K,F,P,CH,SH,TH,HH}) where a voicing onset IS the vowel onset. Primary voicing
instrument = librosa.pyin (pyin_probe.py, nsf venv) — FCPE at the shipped 0.006 threshold is
voicing-always-on (KS-B) — with a threshold-swept FCPE (fcpe_probe.py) as the registered
sensitivity cross-check. Word spans on each render come from MMS_FA forced alignment against
the score's OWN word sequence (align_probe.py, skeleton venv).

Usage (base python3, from scripts/fms-killshot/):
  python3 vowel_landmark.py [--root ~/mosh-fms-ksb/used2] [--out .../mechanism/v0]
                            [--lanes u2-chunks,t1-chunks,u2-snapped,t1-snapped]
                            [--fcpe-thresholds 0.006,0.02,0.05] [--no-whisper]

Outputs into --out: <lane>-words.{csv,json}, summary.json, vowel-landmark.html, cache/.
Pure cores (word_events, onset_cluster, voiced_onset, voiced_run_end, stats) are stdlib and
golden-tested in vowel_landmark_test.py.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

from skeleton import core as skcore  # noqa: E402  (energy_envelope, read_pcm_mono)
import overlap                        # noqa: E402  (global_lag, word_match)

SK_PY = os.path.expanduser(os.environ.get("SKELETON_PY", "~/Library/Mosh/venvs/skeleton/bin/python3"))
NSF_PY = os.path.expanduser(os.environ.get("NSF_PY", "~/Library/Mosh/venvs/nsf/bin/python3"))
WH_PY = os.path.expanduser(os.environ.get("WHISPER_PY", "~/Library/Mosh/venvs/whisper/bin/python3"))

DEFAULT_ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
DEFAULT_OUT = os.path.join(DEFAULT_ROOT, "asserted-proof", "mechanism", "v0")

# ── pure core ──────────────────────────────────────────────────────────────────────────

ARPA_VOWELS = {"AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY",
               "OW", "OY", "UH", "UW"}
VOICELESS = {"S", "T", "K", "F", "P", "CH", "SH", "TH", "HH"}


def phones_of(token: str):
    """'en_SH-EH1-R-D' -> ['SH','EH1','R','D']; '<SP>' -> []."""
    if not token or token == "<SP>":
        return []
    if token.startswith("en_"):
        token = token[3:]
    return [p for p in token.split("-") if p]


def _base(p: str) -> str:
    return p.rstrip("0123456789")


def onset_cluster(token: str):
    """Leading consonant phones before the first vowel of the word's ONSET syllable
    (the type-2 note's phoneme group). -> (cluster_list, all_voiceless_bool)."""
    cluster = []
    for p in phones_of(token):
        if _base(p) in ARPA_VOWELS:
            break
        cluster.append(_base(p))
    return cluster, bool(cluster) and all(p in VOICELESS for p in cluster)


def word_events(clip: dict):
    """Walk the score's duration/text/phoneme/note_type/note_pitch chains into WORD
    instances: one per note_type-2 event, extended through its type-3 run (melisma AND
    later syllables of the same word both ride type 3; a repeated text token that is
    type 2 is a NEW instance — the 'so so so' 2/2/3 case). Times sum the 4dp
    error-diffused duration chain (the take's clock)."""
    durs = [float(d) for d in clip["duration"].split()]
    texts = clip["text"].split()
    phons = clip["phoneme"].split()
    types = [int(x) for x in clip["note_type"].split()]
    pitches = [int(float(x)) for x in clip["note_pitch"].split()]
    n = len(durs)
    if not (len(texts) == len(phons) == len(types) == len(pitches) == n):
        raise ValueError("score token streams disagree in length")
    out, t, cur = [], 0.0, None
    for i in range(n):
        d, nt = durs[i], types[i]
        if nt == 2:
            if cur:
                out.append(cur)
            cur = {"word": texts[i], "phon": phons[i], "start": round(t, 4),
                   "end": round(t + d, 4), "n_notes": 1, "pitches": [pitches[i]]}
        elif nt == 3 and cur:
            cur["end"] = round(t + d, 4)
            cur["n_notes"] += 1
            cur["pitches"].append(pitches[i])
        elif nt == 1 and cur:
            out.append(cur)
            cur = None
        t += d
    if cur:
        out.append(cur)
    return out


def voiced_onset(frames, a: float, b: float, k: int = 3, within_s: float = 0.04):
    """First voicing onset in [a,b] over a DENSE frame list [(t, voiced), ...]: a voiced
    frame with >= k more voiced frames inside the next `within_s`. None if no onset."""
    idx = [i for i, (t, _) in enumerate(frames) if a <= t <= b]
    for i in idx:
        t, v = frames[i]
        if not v:
            continue
        need, got, j = k, 0, i + 1
        while j < len(frames) and frames[j][0] - t <= within_s:
            if frames[j][1]:
                got += 1
            j += 1
        if got >= need:
            return t
    return None


def voiced_run_end(frames, onset_t: float, cap_t: float, max_gap_s: float = 0.02):
    """End of the contiguous voiced run starting at onset_t: the run survives unvoiced
    gaps <= max_gap_s and is capped at cap_t."""
    end = onset_t
    last_voiced = onset_t
    for t, v in frames:
        if t < onset_t:
            continue
        if t > cap_t:
            break
        if v:
            last_voiced = t
            end = t
        elif t - last_voiced > max_gap_s:
            break
    return end


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return None
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def iqr(xs):
    s = sorted(xs)
    n = len(s)
    if n < 4:
        return None
    return s[(3 * n) // 4] - s[n // 4]


def _ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        r = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = r
        i = j + 1
    return ranks


def spearman(xs, ys):
    """Spearman rho with average ranks (ties handled). None if degenerate."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    rx, ry = _ranks(xs), _ranks(ys)
    mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    dx = math.sqrt(sum((a - mx) ** 2 for a in rx))
    dy = math.sqrt(sum((b - my) ** 2 for b in ry))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def ols_slope(xs, ys):
    """Least-squares slope of ys on xs. None if degenerate."""
    if len(xs) != len(ys) or len(xs) < 3:
        return None
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def vowel_onset_report(clip, take_frames, render_frames, offset_s: float = 0.0):
    """QA-grade vowel-landmark readout (B3 of the mechanism-verify Phase B): per word
    instance of `clip`, voicing onsets are searched inside the SCORE span on BOTH sides
    (no forced alignment — assumes the render is take-aligned, i.e. post phrase-snap).
    Clean subset = all-voiceless onsets, where a voicing onset IS the vowel onset.
    Positive delta = the rendered vowel is LATE vs the take's; dur_ratio < 1 = squeezed.
    This is the landmark that replaces word-start snap medians as a quality readout (the
    ~9ms word-snap number measured the wrong landmark — V0/V3). The instrument-grade
    version (MMS_FA word spans + FCPE threshold sweep) is the V0 harness."""
    deltas, ratios, clean_n, n = [], [], 0, 0
    for e in word_events(clip):
        a, b = e["start"] + offset_s, e["end"] + offset_s
        n += 1
        cluster, voiceless = onset_cluster(e["phon"])
        if not (voiceless and len(cluster) >= 1):
            continue
        clean_n += 1
        r_on, r_end = landmarks(render_frames, a, b, None)
        t_on, t_end = landmarks(take_frames, a, b, None)
        if r_on is None or t_on is None:
            continue
        deltas.append((r_on - t_on) * 1000.0)
        if t_end - t_on > 0.01:
            ratios.append((r_end - r_on) / (t_end - t_on))
    return {
        "available": True, "words": n, "clean": clean_n, "measured": len(deltas),
        "median_vowel_onset_delta_ms": round(median(deltas), 1) if deltas else None,
        "median_vowel_dur_ratio": round(median(ratios), 3) if ratios else None,
        "squeeze_frac": round(sum(1 for r in ratios if r < 0.8) / len(ratios), 3) if ratios else None,
    }


# ── venv probes + caching ──────────────────────────────────────────────────────────────

def _run_json(cmd, timeout=1800):
    run = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    out = (run.stdout or "").strip()
    if run.returncode != 0 or not out:
        raise RuntimeError(f"probe failed: {' '.join(cmd)}\n{(run.stderr or '')[-800:]}")
    res = json.loads(out)
    if not res.get("ok"):
        raise RuntimeError(f"probe not ok: {' '.join(cmd)} -> {res.get('error')}")
    return res


def _cache_get(cache_dir, wav, tag):
    st = os.stat(wav)
    key = f"{os.path.basename(wav)}.{tag}.{st.st_size}.{int(st.st_mtime)}"
    path = os.path.join(cache_dir, hashlib.md5(key.encode()).hexdigest() + ".json")
    if os.path.isfile(path):
        with open(path) as f:
            return json.load(f), path
    return None, path


def frames_pyin(cache_dir, wav):
    hit, path = _cache_get(cache_dir, wav, "pyin")
    if hit is None:
        hit = _run_json([NSF_PY, os.path.join(HERE, "pyin_probe.py"), wav])
        with open(path, "w") as f:
            json.dump(hit, f)
    return [(t, bool(v)) for t, _hz, v in hit["frames"]]


def frames_fcpe(cache_dir, wav, threshold):
    hit, path = _cache_get(cache_dir, wav, f"fcpe{threshold}")
    if hit is None:
        hit = _run_json([SK_PY, os.path.join(HERE, "fcpe_probe.py"), wav,
                         "--threshold", str(threshold)])
        with open(path, "w") as f:
            json.dump(hit, f)
    return [(t, hz > 0.0) for t, hz in hit["frames"]]


def align_words_probe(cache_dir, wav, words, t0=None, t1=None):
    tag = "align." + hashlib.md5(json.dumps([words, t0, t1]).encode()).hexdigest()[:10]
    hit, path = _cache_get(cache_dir, wav, tag)
    if hit is None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(words, tf)
            wpath = tf.name
        cmd = [SK_PY, os.path.join(HERE, "align_probe.py"), wav, wpath]
        if t0 is not None:
            cmd += ["--t0", str(t0)]
        if t1 is not None:
            cmd += ["--t1", str(t1)]
        try:
            hit = _run_json(cmd)
        finally:
            os.unlink(wpath)
        with open(path, "w") as f:
            json.dump(hit, f)
    return hit["words"]


def whisper_words(cache_dir, wav):
    hit, path = _cache_get(cache_dir, wav, "whisper")
    if hit is None:
        cli = os.path.join(REPO, "service", "whisper", "whisper_cli.py")
        hit = _run_json([WH_PY, cli, wav])
        with open(path, "w") as f:
            json.dump(hit, f)
    return [w["word"] for w in hit.get("words", [])]


def wav_duration(path):
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())


def read_env(path, t0=None, t1=None):
    r = skcore.read_pcm_mono(path)
    if not r:
        raise RuntimeError(f"not stdlib-readable: {path}")
    mono, sr = r
    if t0 is not None or t1 is not None:
        mono = mono[int((t0 or 0.0) * sr):int(t1 * sr) if t1 is not None else len(mono)]
    return skcore.energy_envelope(mono, sr)


# ── lane registry ──────────────────────────────────────────────────────────────────────

def lanes_registry(root):
    ap_ = os.path.join(root, "asserted-proof")
    fresh = os.path.join(ap_, "fresh")
    scores = os.path.join(ap_, "back-half", "sing-handoff", "scores")
    scores_prev = os.path.join(ap_, "back-half", "sing-handoff", "scores_prev")
    manif = os.path.join(root, "fresh-render")
    return {
        "u2-chunks": {
            "kind": "chunks", "take": os.path.join(fresh, "u2-full-mumble.wav"),
            "manifest": os.path.join(manif, "u2-full-manifest.json"),
            "render_pat": os.path.join(ap_, "voice-soulx-{name}.wav"),
            "score_pat": os.path.join(scores, "{name}.json"),
        },
        "t1-chunks": {
            "kind": "chunks", "take": os.path.join(fresh, "t1-full-mumble.wav"),
            "manifest": os.path.join(manif, "t1-full-manifest.json"),
            "render_pat": os.path.join(ap_, "voice-soulx-{name}.wav"),
            "score_pat": os.path.join(scores_prev, "{name}.json"),
        },
        "u2-snapped": {
            "kind": "full", "take": os.path.join(fresh, "u2-full-mumble.wav"),
            "manifest": os.path.join(manif, "u2-full-manifest.json"),
            "render": os.path.join(fresh, "u2-full-snapped.wav"),
            "score_pat": os.path.join(scores, "{name}.json"),
        },
        "t1-snapped": {
            "kind": "full", "take": os.path.join(fresh, "t1-full-mumble.wav"),
            "manifest": os.path.join(manif, "t1-full-manifest.json"),
            "render": os.path.join(fresh, "t1-full-snapped.wav"),
            "score_pat": os.path.join(scores_prev, "{name}.json"),
        },
    }


def load_chunks(lane):
    """[(name, offset_s, dur_s, clip_dict), ...] with timeline sanity asserts."""
    with open(lane["manifest"]) as f:
        manifest = json.load(f)
    out = []
    for ch in manifest["chunks"]:
        spath = lane["score_pat"].format(name=ch["name"])
        with open(spath) as f:
            clips = json.load(f)
        clip = clips[0] if isinstance(clips, list) else clips
        total = sum(float(d) for d in clip["duration"].split())
        # chunk clips carry SECTION-clock time = [offsetMs, offsetMs + durMs]
        t0, t1 = float(clip["time"][0]) / 1000.0, float(clip["time"][1]) / 1000.0
        dur = t1 - t0
        if abs(total - dur) > 0.005:
            raise RuntimeError(f"{ch['name']}: duration chain {total:.4f}s != time span {dur:.4f}s")
        if abs(dur * 1000.0 - ch["durMs"]) > 10 or abs(t0 * 1000.0 - ch["offsetMs"]) > 5:
            raise RuntimeError(f"{ch['name']}: score time {clip['time']} != manifest "
                               f"offset {ch['offsetMs']} dur {ch['durMs']}")
        out.append((ch["name"], ch["offsetMs"] / 1000.0, dur, clip))
    return out


# ── measurement ────────────────────────────────────────────────────────────────────────

def landmarks(frames, a, b, cap_next):
    """(onset_t, run_end_t) inside [a-0.03, b] with the run capped at min(b+0.05, cap_next)."""
    onset = voiced_onset(frames, a - 0.03, b)
    if onset is None:
        return None, None
    cap = min(b + 0.05, cap_next) if cap_next is not None else b + 0.05
    return onset, voiced_run_end(frames, onset, cap)


def measure_lane(key, lane, out_dir, fcpe_thresholds, use_whisper):
    cache = os.path.join(out_dir, "cache")
    os.makedirs(cache, exist_ok=True)
    chunks = load_chunks(lane)
    take = lane["take"]
    take_pyin = frames_pyin(cache, take)
    take_fcpe = {th: frames_fcpe(cache, take, th) for th in fcpe_thresholds}

    # section-clock word list across all chunks (chunk word events are chunk-local;
    # shift by the manifest offset once, here — everything downstream is section-clock)
    words_by_chunk = []
    for name, off, dur, clip in chunks:
        evs = []
        for e in word_events(clip):
            e["chunk"] = name
            e["start"] = round(e["start"] + off, 4)
            e["end"] = round(e["end"] + off, 4)
            evs.append(e)
        words_by_chunk.append((name, off, dur, evs))

    # section-provenance gate: the take must be voiced inside the score's word spans
    span_frames = 0
    voiced_frames = 0
    for _n, _off, _d, evs in words_by_chunk:
        for e in evs:
            a, b = e["start"], e["end"]
            for t, v in take_pyin:
                if a <= t <= b:
                    span_frames += 1
                    voiced_frames += v
    voiced_frac = (voiced_frames / span_frames) if span_frames else 0.0
    if voiced_frac < 0.6:
        return {"lane": key, "aborted": f"take voicing fraction {voiced_frac:.2f} < 0.6 "
                                        "inside score spans — section registration suspect"}

    rows, notes = [], {"voicedFrac": round(voiced_frac, 3), "chunks": []}

    if lane["kind"] == "chunks":
        # chunk renders are SELF-PLACED on the section clock (leading silence up to their
        # offset; wav duration == offset + chunk duration) — plain-sum assembly convention
        for name, off, dur, evs in words_by_chunk:
            rpath = lane["render_pat"].format(name=name)
            rdur = wav_duration(rpath)
            if abs(rdur - (off + dur)) > 0.05:
                raise RuntimeError(f"{name}: render {rdur:.2f}s != self-placed end {off + dur:.2f}s")
            aligned = align_words_probe(cache, rpath, [e["word"] for e in evs],
                                        t0=off, t1=off + dur)
            for g in aligned:
                g["start"] += off
                g["end"] += off
            rp = frames_pyin(cache, rpath)          # frames already section-clock
            rf = {th: frames_fcpe(cache, rpath, th) for th in fcpe_thresholds}
            lag = overlap.global_lag(read_env(take, off, off + dur),
                                     read_env(rpath, off, off + dur))
            info = {"name": name, "lag_s": lag}
            if use_whisper:
                wm = overlap.word_match([e["word"] for e in evs], whisper_words(cache, rpath))
                info["bag_coverage"] = wm["bag_coverage"]
            notes["chunks"].append(info)
            rows += rows_for(key, evs, aligned, rp, rf, take_pyin, take_fcpe, lag)
    else:  # full assembled render: align window-by-window on the section clock
        rpath = lane["render"]
        all_evs = [e for _n, _off, _d, evs in words_by_chunk for e in evs]
        rp = frames_pyin(cache, rpath)
        rf = {th: frames_fcpe(cache, rpath, th) for th in fcpe_thresholds}
        aligned_all = []
        for w0, w1, sub in alignment_windows(all_evs, wav_duration(rpath)):
            got = align_words_probe(cache, rpath, [e["word"] for e in sub], t0=w0, t1=w1)
            for g in got:
                g["start"] += w0
                g["end"] += w0
            aligned_all += got
        lag = overlap.global_lag(read_env(take), read_env(rpath))
        notes["chunks"].append({"name": "full", "lag_s": lag})
        rows += rows_for(key, all_evs, aligned_all, rp, rf, take_pyin, take_fcpe, lag)
    return {"lane": key, "rows": rows, "notes": notes}


def alignment_windows(evs, total_dur, target_s=30.0, min_gap_s=0.3, pad_s=0.25):
    """Split section-clock word events into alignment windows (<= ~target_s, cut only at
    inter-word gaps >= min_gap_s). -> [(t0, t1, [events]), ...]"""
    wins, cur = [], []
    for e in evs:
        if cur and (e["start"] - cur[0]["start"] > target_s) and (e["start"] - cur[-1]["end"] >= min_gap_s):
            wins.append(cur)
            cur = []
        cur.append(e)
    if cur:
        wins.append(cur)
    out = []
    for w in wins:
        t0 = max(0.0, w[0]["start"] - pad_s)
        t1 = min(total_dur, w[-1]["end"] + pad_s)
        out.append((t0, t1, w))
    return out


def rows_for(lane_key, evs, aligned, render_pyin, render_fcpe, take_pyin, take_fcpe, lag_s):
    """One row per word instance. EVERYTHING is on the section clock (chunk renders are
    self-placed; events/aligned spans are pre-shifted by the caller)."""
    rows = []
    for i, (e, al) in enumerate(zip(evs, aligned)):
        cluster, voiceless = onset_cluster(e["phon"])
        s_start, s_end = e["start"], e["end"]
        w_start, w_end = float(al["start"]), float(al["end"])
        next_start = float(aligned[i + 1]["start"]) if i + 1 < len(aligned) else None
        r_on, r_end = landmarks(render_pyin, w_start, w_end, next_start)
        next_s = evs[i + 1]["start"] if i + 1 < len(evs) else None
        t_on, t_end = landmarks(take_pyin, s_start, s_end, next_s)
        row = {
            "lane": lane_key, "chunk": e.get("chunk", "full"), "word": e["word"],
            "phon": e["phon"], "cluster": "-".join(cluster), "cluster_len": len(cluster),
            "voiceless": voiceless, "clean": voiceless and len(cluster) >= 1,
            "n_notes": e["n_notes"],
            "score_start": round(s_start, 4), "score_end": round(s_end, 4),
            "ctc_score": round(float(al.get("score", 0.0) or 0.0), 3),
            "word_snap_ms": round((w_start - s_start) * 1000, 1),
            "lag_s": lag_s,
        }
        if r_on is not None:
            row["render_vowel_onset"] = round(r_on, 4)
            row["vowel_dur_render"] = round(r_end - r_on, 4)
            row["onset_delta_score_ms"] = round((r_on - s_start) * 1000, 1)
            row["est_cluster_dur_ms"] = round((r_on - w_start) * 1000, 1)
        if t_on is not None:
            row["take_vowel_onset"] = round(t_on, 4)
            row["vowel_dur_take"] = round(t_end - t_on, 4)
        if r_on is not None and t_on is not None:
            row["onset_delta_take_ms"] = round((r_on - t_on) * 1000, 1)
            row["onset_delta_take_lagcorr_ms"] = round((r_on - lag_s - t_on) * 1000, 1)
            if t_end - t_on > 0.01:
                row["dur_ratio"] = round((r_end - r_on) / (t_end - t_on), 3)
        # FCPE sensitivity instruments (onset only)
        fc = {}
        for th, fr in render_fcpe.items():
            o, _ = landmarks(fr, w_start, w_end, next_start)
            to, _ = landmarks(take_fcpe[th], s_start, s_end, next_s)
            if o is not None and to is not None:
                fc[str(th)] = round((o - to) * 1000, 1)
        row["fcpe_onset_delta_ms"] = fc
        rows.append(row)
    return rows


# ── stats + gates ──────────────────────────────────────────────────────────────────────

def usable(rows):
    return [r for r in rows if r["ctc_score"] >= 0.3 and "onset_delta_take_ms" in r]


def bucket_of(r):
    return "0" if r["cluster_len"] == 0 else ("1" if r["cluster_len"] == 1 else "2+")


def summarize(all_rows, fcpe_thresholds):
    raw = [r for r in all_rows if r["lane"].endswith("-chunks")]
    snapped = [r for r in all_rows if r["lane"].endswith("-snapped")]
    out = {"n_rows": len(all_rows)}

    def block(rows, label):
        rows_u = usable(rows)
        clean = [r for r in rows_u if r["clean"]]
        b = {"n": len(rows), "n_usable": len(rows_u), "n_clean": len(clean),
             "excluded_frac": round(1 - len(rows_u) / len(rows), 3) if rows else None}
        for name, sub in (("all", rows_u), ("clean", clean)):
            deltas = [r["onset_delta_take_ms"] for r in sub]
            durs = [r["dur_ratio"] for r in sub if "dur_ratio" in r]
            b[name] = {
                "median_onset_delta_ms": round(median(deltas), 1) if deltas else None,
                "iqr_onset_delta_ms": round(iqr(deltas), 1) if deltas and iqr(deltas) is not None else None,
                "median_dur_ratio": round(median(durs), 3) if durs else None,
                "squeeze_frac": round(sum(1 for d in durs if d < 0.8) / len(durs), 3) if durs else None,
                "median_word_snap_ms": round(median([abs(r["word_snap_ms"]) for r in sub]), 1) if sub else None,
            }
        # buckets + trend on ALL usable (voiced onsets included in the trend set)
        b["buckets"] = {}
        for bk in ("0", "1", "2+"):
            sub = [r for r in rows_u if bucket_of(r) == bk]
            deltas = [r["onset_delta_take_ms"] for r in sub]
            durs = [r["dur_ratio"] for r in sub if "dur_ratio" in r]
            b["buckets"][bk] = {
                "n": len(sub),
                "median_onset_delta_ms": round(median(deltas), 1) if deltas else None,
                "median_dur_ratio": round(median(durs), 3) if durs else None,
            }
        xs = [r["cluster_len"] for r in rows_u]
        ys = [r["onset_delta_take_ms"] for r in rows_u]
        rho, slope = spearman(xs, ys), ols_slope(xs, ys)
        b["trend"] = {"spearman_rho": round(rho, 3) if rho is not None else None,
                      "ols_slope_ms_per_consonant": round(slope, 2) if slope is not None else None}
        # FCPE sensitivity: clean-subset median onset delta per threshold
        sens = {}
        for th in fcpe_thresholds:
            vals = [r["fcpe_onset_delta_ms"][str(th)] for r in clean
                    if str(th) in r.get("fcpe_onset_delta_ms", {})]
            sens[str(th)] = {"n": len(vals), "median_ms": round(median(vals), 1) if vals else None}
        b["fcpe_sensitivity_clean"] = sens
        out[label] = b
        return b

    raw_b = block(raw, "raw_chunks")
    if snapped:
        block(snapped, "snapped")

    # registered gates (raw-chunk lanes gate; snapped is the sub-question)
    clean_med = raw_b["clean"]["median_onset_delta_ms"]
    rho = raw_b["trend"]["spearman_rho"]
    slope = raw_b["trend"]["ols_slope_ms_per_consonant"]
    b2 = raw_b["buckets"]["2+"]
    dur_ok = [raw_b["buckets"][k]["median_dur_ratio"] for k in ("0", "1", "2+")
              if raw_b["buckets"][k]["median_dur_ratio"] is not None]
    lateness = (clean_med is not None and clean_med >= 20.0
                and rho is not None and rho >= 0.3
                and slope is not None and slope >= 15.0)
    squeeze = (b2["median_dur_ratio"] is not None and b2["n"] >= 8
               and b2["median_dur_ratio"] <= 0.85)
    demoted = (clean_med is not None and clean_med < 20.0
               and dur_ok and all(d >= 0.9 for d in dur_ok))
    # instrument stability: pyin vs swept FCPE on the clean subset
    fcpe_meds = [v["median_ms"] for v in raw_b["fcpe_sensitivity_clean"].values()
                 if v["median_ms"] is not None and v["n"] >= 5]
    stable = bool(fcpe_meds) and (max(fcpe_meds) - min(fcpe_meds) <= 10.0)
    small_n = raw_b["buckets"]["2+"]["n"] < 8
    verdict = ("SUPPORTED (lateness)" if lateness else
               "SUPPORTED (squeeze)" if squeeze else
               "DEMOTED" if demoted else "INCONCLUSIVE")
    if not stable:
        verdict = "WITHHELD (instrument unstable across FCPE thresholds)"
    out["gates"] = {"lateness": lateness, "squeeze": squeeze, "demoted": demoted,
                    "instrument_stable": stable, "small_n_2plus": small_n,
                    "verdict": verdict}
    return out


# ── HTML review page ───────────────────────────────────────────────────────────────────

def render_page(out_dir, root, summary, lane_notes, per_lane_rows):
    def esc(x):
        return html.escape(str(x))

    def rel(p):
        return os.path.relpath(p, out_dir)

    def blk(label):
        b = summary.get(label)
        if not b:
            return ""
        rows = "".join(
            f"<tr><td>{k}</td><td>{b['buckets'][k]['n']}</td>"
            f"<td>{b['buckets'][k]['median_onset_delta_ms']}</td>"
            f"<td>{b['buckets'][k]['median_dur_ratio']}</td></tr>"
            for k in ("0", "1", "2+"))
        sens = " · ".join(f"t{th}: {v['median_ms']}ms (n{v['n']})"
                          for th, v in b["fcpe_sensitivity_clean"].items())
        return f"""<div class="card"><h2>{esc(label)}</h2>
  <div class="meta">
    <span>rows {b['n']} · usable {b['n_usable']} · clean {b['n_clean']} · excluded {b['excluded_frac']}</span>
    <span>clean median onset Δ <b>{b['clean']['median_onset_delta_ms']}ms</b> (IQR {b['clean']['iqr_onset_delta_ms']})</span>
    <span>clean median dur ratio <b>{b['clean']['median_dur_ratio']}</b> · squeeze&lt;0.8 frac {b['clean']['squeeze_frac']}</span>
    <span>trend ρ {b['trend']['spearman_rho']} · slope {b['trend']['ols_slope_ms_per_consonant']} ms/consonant</span>
    <span>word-snap median |Δ| {b['all']['median_word_snap_ms']}ms (positive control)</span>
  </div>
  <table><tr><th>cluster</th><th>n</th><th>median onset Δ ms</th><th>median dur ratio</th></tr>{rows}</table>
  <div class="meta"><span>FCPE sweep (clean): {esc(sens)}</span></div>
</div>"""

    audio_cards = ""
    lanes = lanes_registry(root)
    for key, info in lane_notes.items():
        lane = lanes[key]
        chunks_meta = " · ".join(
            f"{c['name']} lag {c['lag_s']:+.3f}s" + (f" bag {c['bag_coverage']}" if "bag_coverage" in c else "")
            for c in info["chunks"])
        take_rel = rel(lane["take"])
        rends = ""
        if lane["kind"] == "full":
            rends = f'<div>render (snapped)</div><audio controls preload="none" src="{esc(rel(lane["render"]))}"></audio>'
        else:
            with open(lane["manifest"]) as f:
                for ch in json.load(f)["chunks"]:
                    rp = lane["render_pat"].format(name=ch["name"])
                    rends += (f'<div>{esc(ch["name"])}</div>'
                              f'<audio controls preload="none" src="{esc(rel(rp))}"></audio>')
        audio_cards += f"""<div class="card"><h2>{esc(key)}</h2>
  <div class="meta"><span>take voiced-frac {info['voicedFrac']}</span><span>{esc(chunks_meta)}</span></div>
  <div>take</div><audio controls preload="none" src="{esc(take_rel)}"></audio>
  {rends}
</div>"""

    g = summary["gates"]
    worst = ""
    raw_rows = [r for rows in per_lane_rows.values() for r in usable(rows)
                if r["lane"].endswith("-chunks") and r["clean"]]
    for r in sorted(raw_rows, key=lambda r: -abs(r.get("onset_delta_take_ms", 0)))[:15]:
        worst += (f"<tr><td>{esc(r['lane'])}</td><td>{esc(r['word'])}</td><td>{esc(r['cluster'])}</td>"
                  f"<td>{r['onset_delta_take_ms']:+.0f}</td><td>{r.get('dur_ratio', '')}</td>"
                  f"<td>{r.get('est_cluster_dur_ms', '')}</td><td>{r['score_start']:.2f}s</td></tr>")

    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>V0 vowel-landmark review</title>
<style>
 :root{{color-scheme:dark}}
 body{{margin:0;background:#0f1116;color:#e8ebf3;font:15px/1.45 -apple-system,system-ui,sans-serif}}
 .wrap{{max-width:1040px;margin:0 auto;padding:34px 18px 64px}}
 .card{{background:#16181f;border:1px solid #252934;border-radius:16px;padding:16px 18px;margin:0 0 16px}}
 .verdict{{border-color:#3d7bfd;font-size:18px}}
 h1{{margin:0 0 4px;font-size:24px}} h2{{margin:0 0 8px;font-size:16px}}
 .sub{{margin:0 0 16px;color:#9097a7;font-size:13px}}
 .meta{{display:flex;gap:14px;flex-wrap:wrap;color:#9097a7;font-size:12px;margin:8px 0}}
 .meta b{{color:#e8ebf3}}
 audio{{width:100%;margin:4px 0 10px}}
 table{{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}}
 td,th{{border:1px solid #2a2f3c;padding:6px 8px;text-align:right}}
 td:first-child,th:first-child,td:nth-child(2),th:nth-child(2){{text-align:left}}
</style></head><body><div class="wrap">
  <h1>V0 — vowel-landmark measurement</h1>
  <p class="sub">Registered spec: docs/superpowers/specs/2026-07-16-fms-mechanism-verify-design.md.
  Positive Δ = rendered vowel onset LATE vs the take's. Clean subset = all-voiceless onsets
  (voicing onset ≡ vowel onset). Primary instrument: pyin voicing; FCPE threshold sweep as
  the stability check.</p>
  <div class="card verdict"><h2>Verdict: {esc(g['verdict'])}</h2>
    <div class="meta"><span>lateness gate {g['lateness']}</span><span>squeeze gate {g['squeeze']}</span>
    <span>demoted {g['demoted']}</span><span>instrument stable {g['instrument_stable']}</span>
    <span>2+ bucket small-n {g['small_n_2plus']}</span></div></div>
  {blk('raw_chunks')}
  {blk('snapped')}
  <div class="card"><h2>Worst clean-subset words (raw chunks)</h2>
    <table><tr><th>lane</th><th>word</th><th>cluster</th><th>onset Δ ms</th><th>dur ratio</th><th>est cluster ms</th><th>at</th></tr>
    {worst}</table></div>
  {audio_cards}
</div></body></html>"""
    path = os.path.join(out_dir, "vowel-landmark.html")
    with open(path, "w") as f:
        f.write(page)
    return path


# ── main ───────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--lanes", default="u2-chunks,t1-chunks,u2-snapped,t1-snapped")
    ap.add_argument("--fcpe-thresholds", default="0.006,0.02,0.05")
    ap.add_argument("--no-whisper", action="store_true")
    args = ap.parse_args()

    root = os.path.abspath(os.path.expanduser(args.root))
    out_dir = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(out_dir, exist_ok=True)
    thresholds = [float(x) for x in args.fcpe_thresholds.split(",") if x]
    lanes = lanes_registry(root)

    all_rows, lane_notes, per_lane_rows = [], {}, {}
    for key in [k.strip() for k in args.lanes.split(",") if k.strip()]:
        if key not in lanes:
            raise SystemExit(f"unknown lane {key}")
        print(f"== lane {key}", flush=True)
        res = measure_lane(key, lanes[key], out_dir, thresholds, not args.no_whisper)
        if res.get("aborted"):
            print(f"   ABORTED: {res['aborted']}", flush=True)
            lane_notes[key] = {"voicedFrac": 0, "chunks": [], "aborted": res["aborted"]}
            continue
        rows = res["rows"]
        per_lane_rows[key] = rows
        lane_notes[key] = res["notes"]
        all_rows += rows
        with open(os.path.join(out_dir, f"{key}-words.json"), "w") as f:
            json.dump(rows, f, indent=1)
        cols = ["lane", "chunk", "word", "phon", "cluster", "cluster_len", "voiceless",
                "clean", "n_notes", "score_start", "score_end", "ctc_score", "word_snap_ms",
                "render_vowel_onset", "take_vowel_onset", "onset_delta_take_ms",
                "onset_delta_take_lagcorr_ms", "onset_delta_score_ms", "vowel_dur_render",
                "vowel_dur_take", "dur_ratio", "est_cluster_dur_ms", "lag_s"]
        with open(os.path.join(out_dir, f"{key}-words.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        print(f"   {len(rows)} word rows", flush=True)

    summary = summarize(all_rows, thresholds)
    summary["laneNotes"] = lane_notes
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    page = render_page(out_dir, root, summary, {k: v for k, v in lane_notes.items()
                                                if "aborted" not in v}, per_lane_rows)
    print(json.dumps({"ok": True, "verdict": summary["gates"]["verdict"],
                      "summary": os.path.join(out_dir, "summary.json"),
                      "page": page}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
