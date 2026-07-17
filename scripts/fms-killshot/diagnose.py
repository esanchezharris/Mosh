#!/usr/bin/env python3
"""KS-B diagnostic harness: mumble take -> skeleton, with everything the product path
throws away kept visible (Finish-My-Song kill-shot B; plan 2026-07-02, v2 A/B 2026-07-03).

Two segmentation algorithms over the SAME model outputs (Basic Pitch via the transcribe
venv, FCPE via the skeleton venv):

  v1 — the shipped path: Basic-Pitch notes, split at raw frame-to-frame F0 jumps
       (service/skeleton/core.py + service/lyrics/mumble.py, called directly)
  v2 — owner's rule (2026-07-03): energy-gate re-attacks + sustained pitch steps,
       snapped-with-tolerance to a 1/8 grid (scripts/fms-killshot/segment_v2.py)

--algo both (default) writes <out>-v1/ and <out>-v2/ (diagnostic.json, beeps.wav,
overlay.wav, input.wav each — the naming convention makes make_listening_page.py show
them as adjacent sections) plus <out>-compare.json. Audible proofs: sine per nucleus at
its pitch; melisma-mangle is audible as one held vowel turning into several beeps.

Determinism: --runs N re-runs the model subprocesses and diffs each algo's JSON.

Usage:
  diagnose.py --input take.m4a --bpm 120 [--time-sig 4/4] [--grid 1/16] --out outbase
              [--algo v1|v2|both] [--runs 2] [--no-f0]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
MAIN_CHECKOUT = os.path.expanduser(os.environ.get("MOSH_CHECKOUT", "~/Mosh"))

sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)
from skeleton import core as skcore          # noqa: E402  (pure stdlib)
from lyrics import mumble                    # noqa: E402  (pure stdlib)
import segment_v2                            # noqa: E402  (pure stdlib)


def _venv_python(env_rel: str, var: str) -> str | None:
    """Resolve a venv python from a service .env file, repo checkout first then main."""
    for root in (REPO, MAIN_CHECKOUT):
        p = os.path.join(root, "service", env_rel)
        if not os.path.isfile(p):
            continue
        for line in open(p):
            line = line.strip()
            if line.startswith(f"export {var}="):
                py = line.split("=", 1)[1].strip().strip('"')
                if os.path.isfile(py):
                    return py
    return None


def _stdlib_readable(path: str) -> bool:
    """True only for plain PCM (fmt tag 1) 16/24-bit WAVs. Do NOT trust wave.open here:
    Python >=3.12 accepts WAVE_FORMAT_EXTENSIBLE (tag 0xFFFE) but the 3.11 venvs reject it."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return False
            f.seek(12)
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return False
                cid, sz = hdr[:4], int.from_bytes(hdr[4:8], "little")
                if cid == b"fmt ":
                    fmt = f.read(sz)
                    tag = int.from_bytes(fmt[0:2], "little")
                    bits = int.from_bytes(fmt[14:16], "little")
                    return tag == 1 and bits in (16, 24)
                f.seek(sz + (sz & 1), 1)
    except Exception:
        return False


def _to_wav(src: str, tmpdir: str) -> str:
    """Decode any input to a PCM WAV the stdlib `wave` reader handles (skeleton_cli.py's
    constraint). afconvert can emit WAVE_FORMAT_EXTENSIBLE (fmt tag 65534) which stdlib
    rejects — fall back to ffmpeg, then to an afconvert AIFF->WAV double hop."""
    if src.lower().endswith(".wav") and _stdlib_readable(src):
        return src
    dst = os.path.join(tmpdir, "input-decoded.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@44100", "-c", "1", src, dst],
                   check=True, capture_output=True)
    if _stdlib_readable(dst):
        return dst
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-y", "-i", src, "-acodec", "pcm_s16le", "-ar", "44100",
                        "-ac", "1", dst], check=True, capture_output=True)
        if _stdlib_readable(dst):
            return dst
    aiff = os.path.join(tmpdir, "input-decoded.aiff")
    subprocess.run(["afconvert", "-f", "AIFF", "-d", "BEI16@44100", "-c", "1", src, aiff],
                   check=True, capture_output=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", aiff, dst],
                   check=True, capture_output=True)
    if not _stdlib_readable(dst):
        raise RuntimeError("could not produce a stdlib-readable PCM WAV from input")
    return dst


def _read_wav_mono(path: str):
    with wave.open(path, "rb") as w:
        ch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(nf)
    if sw == 3:
        inter = []
        for k in range(0, len(raw) - 2, 3):
            v = raw[k] | (raw[k + 1] << 8) | (raw[k + 2] << 16)
            if v & 0x800000:
                v -= 0x1000000
            inter.append(v / 8388608.0)
    else:
        cnt = len(raw) // 2
        inter = [v / 32768.0 for v in struct.unpack("<%dh" % cnt, raw)] if cnt else []
    if ch <= 1:
        return inter, sr
    frames = len(inter) // ch
    return [sum(inter[i * ch:(i + 1) * ch]) / ch for i in range(frames)], sr


def _run_json(py: str, script: str, *args: str) -> dict:
    r = subprocess.run([py, script, *args], capture_output=True, text=True, timeout=600)
    out = (r.stdout or "").strip()
    if not out:
        raise RuntimeError(f"{os.path.basename(script)} produced no stdout; stderr tail: {r.stderr[-400:]}")
    return json.loads(out)


def _midi_hz(p: float) -> float:
    return 440.0 * (2.0 ** ((p - 69) / 12.0))


def _beep_octave_shift(pitches: list) -> int:
    """Whole-octave lift so the beep register is audible on real speakers (low takes
    render as 65-200 Hz sine rumble — 'sounds terrible' and impossible to count).
    Global shift preserves the melodic contour exactly; median lands nearest A4."""
    ps = [p for p in pitches if p]
    if not ps:
        return 0
    med = sorted(ps)[len(ps) // 2]
    return max(0, round((69 - med) / 12.0)) * 12


def _write_beeps(nuclei: list, note_pitch: list, total_s: float, out_path: str,
                 original: list | None = None, sr: int = 44100) -> None:
    """Sine beep per nucleus at its pitch. If `original` given, write stereo
    L=original*0.35 / R=beeps; else mono beeps."""
    n_total = int(total_s * sr) + sr // 4
    beeps = [0.0] * n_total
    lift = _beep_octave_shift(list(note_pitch))
    for nuc, pitch in zip(nuclei, note_pitch):
        s, e = int(nuc["start"] * sr), int(nuc["end"] * sr)
        e = min(max(e, s + 1), n_total)
        hz = _midi_hz(pitch + lift)
        fade = max(1, min(int(0.008 * sr), (e - s) // 3))
        for i in range(s, e):
            env = min(1.0, (i - s) / fade, (e - i) / fade)
            beeps[i] += 0.5 * env * math.sin(2.0 * math.pi * hz * ((i - s) / sr))
    with wave.open(out_path, "wb") as w:
        if original is None:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767)))) for v in beeps))
        else:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
            frames = bytearray()
            for i in range(n_total):
                o = original[i] * 0.35 if i < len(original) else 0.0
                frames += struct.pack("<hh", max(-32767, min(32767, int(o * 32767))),
                                      max(-32767, min(32767, int(beeps[i] * 32767))))
            w.writeframes(bytes(frames))


def _fetch_models(wav: str, bp_py: str, sk_py: str | None):
    """One Basic Pitch + one FCPE subprocess run -> (notes, f0)."""
    notes_res = _run_json(bp_py, os.path.join(REPO, "service/transcribe/transcribe_cli.py"), wav, "mono")
    if not notes_res.get("ok"):
        raise RuntimeError(f"basic pitch failed: {notes_res.get('error')}")
    f0 = None
    if sk_py is not None:
        f0_res = _run_json(sk_py, os.path.join(REPO, "service/skeleton/skeleton_cli.py"), wav)
        if f0_res.get("ok"):
            f0 = f0_res.get("f0") or None
    return notes_res["notes"], f0


def _bars_table(notes: list, nuclei: list, bpm: float, time_sig, grid: str) -> list:
    spb = mumble._sec_per_bar(bpm, time_sig)
    per_bar = mumble._grid_per_bar(grid)
    note_bins = dict(mumble._bin_bars(notes, spb))
    nuc_bins = dict(mumble._bin_bars(nuclei, spb))
    bars = []
    for b in sorted(set(note_bins) | set(nuc_bins)):
        nn, nu = note_bins.get(b, []), nuc_bins.get(b, [])
        bars.append({
            "bar": b, "notes": len(nn), "nuclei": len(nu),
            "syllableTarget": min(len(nu), per_bar) if nu else 0,
            "clamped": len(nu) > per_bar,
            "stress": mumble._stress(nu[:per_bar]) if nu else "",
        })
    return bars


def _derive_v1(notes: list, f0, bpm: float, time_sig, grid: str) -> dict:
    """The shipped path: skcore nuclei split + mumble binning (unchanged from v1 harness)."""
    nuclei = skcore.nuclei_from_notes(notes, f0)
    spec = skcore.build_skeleton_spec(notes, f0, bpm=bpm, time_sig=time_sig, grid=grid)
    provenance, flat_pitch = [], []
    for n in notes:
        subs = skcore.nuclei_from_notes([n], f0)
        provenance.append({"note": n, "nuclei": len(subs),
                           "cuts": [round(s["start"], 4) for s in subs[1:]]})
        flat_pitch += [n.get("pitch", 69)] * len(subs)
    return {
        "algo": "v1",
        "input_notes": notes,
        "f0_stats": {"voiced_frames": len(f0) if f0 else 0, "backend": "fcpe" if f0 else None},
        "nuclei": nuclei,
        "split_provenance": provenance,
        "splits_total": sum(p["nuclei"] - 1 for p in provenance),
        "bars": _bars_table(notes, nuclei, bpm, time_sig, grid),
        "line_spec": spec,
        "_flat_pitch": flat_pitch,
    }


def _derive_v2(mono: list, sr: int, notes: list, f0, bpm: float, time_sig, grid: str) -> dict:
    """Owner's rule: gate re-attacks + sustained pitch steps, snapped to a 1/8 grid.
    Basic-Pitch notes remain in the diagnostic as reference only."""
    r = segment_v2.nuclei_v2(mono, sr, f0, bpm, time_sig=time_sig)
    nuclei = r["nuclei"]
    spec = mumble.build_spec_from_take(nuclei, [], bpm, time_sig=time_sig, grid=grid)
    if spec.get("ok"):
        spec["source"] = "skeleton-v2"
        spec["editable"] = True
    return {
        "algo": "v2",
        "input_notes": notes,
        "f0_stats": {"voiced_frames": len(f0) if f0 else 0, "backend": "fcpe" if f0 else None},
        "nuclei": nuclei,
        "boundaries": r["boundaries"],
        "splits_total": r["boundaries"]["legato_kept"],   # v2's melisma-candidate count
        "bars": _bars_table(notes, nuclei, bpm, time_sig, grid),
        "line_spec": spec,
        "_flat_pitch": [n["pitch"] if n.get("pitch") else 50 for n in nuclei],
    }


def _write_beeps_legato(groups: list, total_s: float, out_path: str,
                        original: list | None = None, sr: int = 44100) -> None:
    """Articulation-aware re-synth: ONE tone per articulation group — single attack and
    release, phase-continuous, pitch GLIDING (~40 ms) across melisma segment boundaries —
    so a slide audibly reads as one word and only real articulations re-attack."""
    n_total = int(total_s * sr) + sr // 4
    beeps = [0.0] * n_total
    GLIDE_S = 0.04
    lift = _beep_octave_shift([s["pitch"] for g in groups for s in g["segments"]])
    for g in groups:
        gs, ge = float(g["start"]), float(g["end"])
        s, e = int(gs * sr), min(max(int(ge * sr), int(gs * sr) + 1), n_total)
        segs = g["segments"]
        bounds = [float(x["start"]) for x in segs[1:]]

        def hz_at(t: float) -> float:
            i = 0
            while i < len(bounds) and t >= bounds[i]:
                i += 1
            f_cur = _midi_hz(segs[i]["pitch"] + lift)
            if i < len(bounds):                       # glide INTO the next segment
                d = bounds[i] - t
                if d < GLIDE_S:
                    f_next = _midi_hz(segs[i + 1]["pitch"] + lift)
                    return f_cur + (f_next - f_cur) * (1.0 - d / GLIDE_S) * 0.5
            if i > 0:                                 # glide OUT of the previous one
                d = t - bounds[i - 1]
                if d < GLIDE_S:
                    f_prev = _midi_hz(segs[i - 1]["pitch"] + lift)
                    mid = 0.5 * (f_prev + f_cur)
                    return mid + (f_cur - mid) * (d / GLIDE_S)
            return f_cur

        fade = max(1, min(int(0.008 * sr), (e - s) // 3))
        phase = 0.0
        for i in range(s, e):
            t = i / sr
            phase += 2.0 * math.pi * hz_at(t) / sr
            env = min(1.0, (i - s) / fade, (e - i) / fade)
            beeps[i] += 0.5 * env * math.sin(phase)
    with wave.open(out_path, "wb") as w:
        if original is None:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
            w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(v * 32767)))) for v in beeps))
        else:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
            frames = bytearray()
            for i in range(n_total):
                o = original[i] * 0.35 if i < len(original) else 0.0
                frames += struct.pack("<hh", max(-32767, min(32767, int(o * 32767))),
                                      max(-32767, min(32767, int(beeps[i] * 32767))))
            w.writeframes(bytes(frames))


def _derive_v3(mono: list, sr: int, notes: list, f0, bpm: float, time_sig, grid: str) -> dict:
    """v1 base + the owner's rule as a PRUNER (ear verdict 2026-07-03: v1 close, v2 out).
    Keeps v1's density/16ths/pitches; merges evidence-free boundaries; snaps to 16ths
    with 8th/quarter preference. See segment_v2.prune_v1_nuclei."""
    v1 = _derive_v1(notes, f0, bpm, time_sig, grid)
    pr = segment_v2.prune_v1_nuclei(v1["nuclei"], v1["_flat_pitch"], mono, sr, f0, bpm)
    # Melisma rule (owner, 2026-07-03): a "note"-kind boundary (pitch changed, energy
    # continuous) does NOT start a new word/syllable — groups count as ONE slot; the
    # per-note segments stay underneath for the Phase-3 render skeleton.
    groups = segment_v2.articulation_groups(pr["nuclei"], pr["pitches"])
    spec = mumble.build_spec_from_take(groups, [], bpm, time_sig=time_sig, grid=grid)
    if spec.get("ok"):
        spec["source"] = "skeleton-v3"
        spec["editable"] = True
    return {
        "algo": "v3",
        "input_notes": notes,
        "f0_stats": v1["f0_stats"],
        "nuclei": pr["nuclei"],
        "articulations": groups,
        "boundaries": {**pr["evidence"], "merged_away": pr["merged_away"],
                       "v1_nuclei": len(v1["nuclei"]),
                       "melisma_groups": sum(1 for g in groups if len(g["segments"]) > 1)},
        "splits_total": v1["splits_total"],
        "bars": _bars_table(notes, groups, bpm, time_sig, grid),
        "line_spec": spec,
        "_groups": groups,
    }


def _asr_words(wav: str, cache_path: str, model: str) -> list:
    """Generously-decoded Whisper words with per-word syllable budgets, cached per take
    (one inference per take; --runs N diffs the deterministic fusion, not the model)."""
    if os.path.isfile(cache_path):
        return json.load(open(cache_path))
    wp = _venv_python("whisper/.whisper.env", "WHISPER_PY")
    if not wp:
        return []
    cli = None
    for root in (REPO, MAIN_CHECKOUT):
        p = os.path.join(root, "service/whisper/whisper_cli.py")
        if os.path.isfile(p):
            cli = p
            break
    if not cli:
        return []
    res = _run_json(wp, cli, wav, model)
    if not res.get("ok"):
        return []
    from phonology import core as ph   # service/ already on sys.path
    pr = ph.Pronouncer()
    words = []
    for w in res.get("words", []):
        c = str(w.get("word", "")).strip(" .,!?'\"-").lower()
        if not any(ch.isalpha() for ch in c):
            continue
        words.append({"word": w.get("word", "").strip(), "start": float(w["start"]),
                      "end": float(w["end"]), "confidence": w.get("confidence"),
                      "syl": pr.syllables(c) or 1})
    with open(cache_path, "w") as f:
        json.dump(words, f, indent=1)
    return words


def _derive_v4(mono: list, sr: int, notes: list, f0, bpm: float, time_sig, grid: str,
               words: list) -> dict:
    """v4 = v3 + the ASR syllable budget (owner's idea 2026-07-03: 'ASR counts, DSP
    times'). Whisper's generous words gate how many slots a word span may keep."""
    v3 = _derive_v3(mono, sr, notes, f0, bpm, time_sig, grid)
    fused, st = segment_v2.fuse_asr_budget(v3["_groups"], words, bpm)
    spec = mumble.build_spec_from_take(fused, [], bpm, time_sig=time_sig, grid=grid)
    if spec.get("ok"):
        spec["source"] = "skeleton-v4"
        spec["editable"] = True
    return {
        "algo": "v4",
        "input_notes": notes,
        "f0_stats": v3["f0_stats"],
        "nuclei": v3["nuclei"],
        "articulations": fused,
        "boundaries": {**v3["boundaries"], **st,
                       "v3_articulations": len(v3["articulations"])},
        "splits_total": v3["splits_total"],
        "bars": _bars_table(notes, fused, bpm, time_sig, grid),
        "line_spec": spec,
        "_groups": fused,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--time-sig", default="4/4")
    ap.add_argument("--grid", default="1/16")
    ap.add_argument("--out", required=True, help="output BASE: writes <out>-<algo>/ per algo")
    ap.add_argument("--algo", default="v1,v3",
                    help="comma list of v1|v2|v3|v4 ('both' = v1,v2 legacy); first two are compared")
    ap.add_argument("--whisper-model", default="small", help="ASR model for v4's word budgets")
    ap.add_argument("--runs", type=int, default=1, help="re-run models N times; diff results")
    ap.add_argument("--no-f0", action="store_true", help="force the no-FCPE degradation path")
    args = ap.parse_args()

    bp_py = _venv_python("transcribe/.transcribe.env", "BASIC_PITCH_PY")
    if not bp_py:
        print("FATAL: Basic Pitch venv not found (run service/transcribe/setup-transcribe.sh)", file=sys.stderr)
        return 2
    sk_py = None if args.no_f0 else _venv_python("skeleton/.skeleton.env", "SKELETON_PY")

    ts = tuple(int(x) for x in args.time_sig.split("/"))
    algos = tuple("v1,v2".split(",") if args.algo == "both" else args.algo.split(","))
    for a in algos:
        if a not in ("v1", "v2", "v3", "v4"):
            print(f"FATAL: unknown algo {a!r}", file=sys.stderr)
            return 2

    with tempfile.TemporaryDirectory() as td:
        wav = _to_wav(os.path.abspath(args.input), td)
        mono, sr = _read_wav_mono(wav)
        total_s = len(mono) / float(sr) if sr else 0.0

        reports: dict = {}
        digests: dict = {a: [] for a in algos}
        f0_last = None
        for _ in range(max(1, args.runs)):
            notes, f0 = _fetch_models(wav, bp_py, sk_py)
            f0_last = f0
            in_stem = os.path.splitext(os.path.basename(args.input))[0]
            words = _asr_words(wav, f"{args.out}-words-{in_stem}-{args.whisper_model}.json",
                               args.whisper_model) \
                if "v4" in algos else []
            derive = {"v1": lambda: _derive_v1(notes, f0, args.bpm, ts, args.grid),
                      "v2": lambda: _derive_v2(mono, sr, notes, f0, args.bpm, ts, args.grid),
                      "v3": lambda: _derive_v3(mono, sr, notes, f0, args.bpm, ts, args.grid),
                      "v4": lambda: _derive_v4(mono, sr, notes, f0, args.bpm, ts, args.grid, words)}
            for a in algos:
                r = derive[a]()
                public = {k: v for k, v in r.items() if not k.startswith("_")}
                digests[a].append(hashlib.sha256(json.dumps(public, sort_keys=True).encode()).hexdigest())
                reports[a] = r

        for a in algos:
            outdir = f"{args.out}-{a}"
            os.makedirs(outdir, exist_ok=True)
            r = reports[a]
            if "_groups" in r:   # v3: articulation-aware legato re-synth
                _write_beeps_legato(r["_groups"], total_s, os.path.join(outdir, "beeps.wav"))
                _write_beeps_legato(r["_groups"], total_s, os.path.join(outdir, "overlay.wav"),
                                    original=mono, sr=sr)
            else:
                _write_beeps(r["nuclei"], r["_flat_pitch"], total_s, os.path.join(outdir, "beeps.wav"))
                _write_beeps(r["nuclei"], r["_flat_pitch"], total_s, os.path.join(outdir, "overlay.wav"),
                             original=mono, sr=sr)
            shutil.copyfile(wav, os.path.join(outdir, "input.wav"))
            diag = {
                "input": os.path.abspath(args.input), "bpm": args.bpm,
                "time_sig": args.time_sig, "grid": args.grid,
                "venvs": {"basic_pitch": bp_py, "fcpe": sk_py},
                "determinism": {"runs": len(digests[a]), "digests": digests[a],
                                "stable": len(set(digests[a])) == 1},
                **{k: v for k, v in r.items() if not k.startswith("_")},
            }
            with open(os.path.join(outdir, "diagnostic.json"), "w") as f:
                json.dump(diag, f, indent=1, sort_keys=True)
            if f0_last is not None:
                with open(os.path.join(outdir, "f0.json"), "w") as f:
                    json.dump(f0_last, f)
            if a == "v2":
                extra = (f" dips={r['boundaries']['dip_kept']} legato={r['boundaries']['legato_kept']}"
                         f" grid-dropped={r['boundaries']['dropped_by_grid']}")
            elif a == "v3":
                b = r["boundaries"]
                extra = (f" artics={len(r['articulations'])} melisma={b['melisma_groups']}"
                         f" merged={b['merged_away']}/{b['v1_nuclei']}"
                         f" (gap={b['gap']} note={b['note']} dip={b['dip']})")
            elif a == "v4":
                b = r["boundaries"]
                extra = (f" artics={len(r['articulations'])} (v3={b['v3_articulations']})"
                         f" asr_words={b['asr_words']} folded={b['folded_by_asr']}"
                         f" over={b['words_over']} under={b['words_under']}"
                         f" outside={b['unassigned_groups']}")
            else:
                extra = f" splits={r['splits_total']}"
            print(f"[{a}] notes={len(r['input_notes'])} nuclei={len(r['nuclei'])}{extra} "
                  f"bars={len(r['bars'])} f0={'yes' if r['f0_stats']['backend'] else 'NO (degraded)'} "
                  f"deterministic={len(set(digests[a])) == 1}")

        if len(algos) >= 2:
            a1, a2 = algos[0], algos[1]
            b1 = {b["bar"]: b for b in reports[a1]["bars"]}
            b2 = {b["bar"]: b for b in reports[a2]["bars"]}
            rows = []
            for b in sorted(set(b1) | set(b2)):
                rows.append({"bar": b,
                             f"{a1}_syl": b1.get(b, {}).get("syllableTarget", 0),
                             f"{a2}_syl": b2.get(b, {}).get("syllableTarget", 0),
                             f"{a1}_stress": b1.get(b, {}).get("stress", ""),
                             f"{a2}_stress": b2.get(b, {}).get("stress", "")})
            cmp_doc = {"input": os.path.abspath(args.input), "bpm": args.bpm,
                       "algos": [a1, a2],
                       "totals": {f"{a}_nuclei": len(reports[a]["nuclei"]) for a in (a1, a2)},
                       "boundaries": {a: reports[a].get("boundaries") for a in (a1, a2)
                                      if reports[a].get("boundaries")},
                       "bars": rows}
            with open(f"{args.out}-compare.json", "w") as f:
                json.dump(cmp_doc, f, indent=1)
            print(f"  bar  {a1:>3} {a2:>3}   (stress {a1} | {a2})")
            for row in rows[:16]:
                print(f"  {row['bar']:>3}  {row[f'{a1}_syl']:>3} {row[f'{a2}_syl']:>3}   "
                      f"{row[f'{a1}_stress']} | {row[f'{a2}_stress']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
