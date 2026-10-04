#!/usr/bin/env python3
"""Out-of-process evidence for the track-chain preset "Mosh Clean Lead v0".

Two things `--selftest` cannot do from inside one process:

  reopen    Apply the preset in process 1, save, quit. Open that project in a FRESH
            process 2 and require the same chain: same order, values, bypass, ownership
            tags and target track, and the same rendered audio. (A harness run wipes its
            session at startup, so the two runs use two session leaves and process 2
            opens process 1's project file by path.)

  audition  Dry and processed renders of real vocal recordings at three input levels,
            with a loudness-matched copy of each processed render, plus measurements.
            This PREPARES a listening session. It is not one: nothing here says the
            preset sounds good, and no script can.

Both drive the built app through `--run-script` (the same MoshOps command surface the UI
uses) with no audio device. Source recordings are opened read-only, copied into the
harness session by import_clip, and hashed before and after.

Audition sources must be plain PCM WAVs with no tempo metadata. A BPM token in the file
name, an ACID chunk, or a FLAC makes the app queue a stretch/convert proxy and the headless
export stalls. Make a clean copy first, e.g.
    ffmpeg -i in.flac -map_metadata -1 -fflags +bitexact -flags:a +bitexact -c:a pcm_s24le out.wav

    scripts/vocal-preset/verify.py reopen   --bin <Mosh binary>
    scripts/vocal-preset/verify.py audition --bin <Mosh binary> --source-dir <dir> --out <dir>

Always pass --bin: an unqualified run must never pick up an installed app.
Exit 0 = every check passed. Loudness matching needs ffmpeg (ebur128) on PATH.
"""
import argparse
import array
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

PRESET_REL = "Contents/Resources/presets/track-chain/mosh-clean-lead-v0.json"
PRESET_ID = "mosh.clean-lead"
HARNESS_ROOT = Path.home() / "Library" / "Mosh" / "_harness"


# ── running the app ────────────────────────────────────────────────────────────────
def run_script(binary, leaf, commands, workdir, timeout=900):
    """Run one --run-script process in its own isolated session leaf; return result lines."""
    script = workdir / f"{leaf}.jsonl"
    out = workdir / f"{leaf}-out.jsonl"
    script.write_text("\n".join(json.dumps(c) for c in commands) + "\n")
    out.unlink(missing_ok=True)
    env = dict(os.environ, MOSH_NO_AUDIO="1", MOSH_ENABLE_SA3="0",
               MOSH_SELFTEST_SESSION=f"_harness/{leaf}",
               MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(out))
    proc = subprocess.run([str(binary), "--run-script"], env=env, timeout=timeout,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    lines = [json.loads(l) for l in out.read_text().splitlines() if l.strip()] if out.exists() else []
    return proc.returncode, lines, proc.stderr[-2000:]


def result(lines, command, nth=0):
    hits = [l for l in lines if l.get("command") == command]
    return hits[nth] if len(hits) > nth else {}


def preset_path(binary):
    # <bundle>/Contents/MacOS/Mosh -> <bundle>/Contents/Resources/presets/...
    return Path(binary).resolve().parents[2] / PRESET_REL


# ── audio ──────────────────────────────────────────────────────────────────────────
def write_stepped_tone(path, levels, seconds_each=0.6, sr=48000):
    """16-bit stereo 1 kHz tone stepping up through `levels` (linear peak)."""
    frames = array.array("h")
    n = int(seconds_each * sr)
    for a, level in enumerate(levels):
        for i in range(n):
            s = int(round(32767 * level * math.sin(2 * math.pi * 1000.0 * (a * n + i) / sr)))
            frames.extend((s, s))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames.tobytes())


def read_float_wav(path):
    """Minimal RIFF reader for the 32-bit float WAVs export_audio writes.
    Returns (sample_rate, channels, array('f') interleaved)."""
    data = Path(path).read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a RIFF/WAVE file")
    pos, fmt, samples = 12, None, None
    while pos + 8 <= len(data):
        tag, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if tag == b"fmt ":
            code, channels, sr, _, _, bits = struct.unpack("<HHIIHH", body[:16])
            if code == 0xFFFE and len(body) >= 26:          # WAVE_FORMAT_EXTENSIBLE: real code in the GUID
                code = struct.unpack("<H", body[24:26])[0]
            fmt = (code, channels, sr, bits)
        elif tag == b"data":
            samples = body
        pos += 8 + size + (size & 1)
    if fmt is None or samples is None:
        raise ValueError(f"{path}: missing fmt/data chunk")
    code, channels, sr, bits = fmt
    if code != 3 or bits != 32:
        raise ValueError(f"{path}: expected 32-bit float, got format {code} / {bits} bit")
    out = array.array("f")
    out.frombytes(samples[:len(samples) - len(samples) % 4])
    if sys.byteorder != "little":
        out.byteswap()
    return sr, channels, out


def db(x):
    return 20.0 * math.log10(max(x, 1e-12))


def peak_and_rms(samples):
    peak, total = 0.0, 0.0
    for s in samples:
        a = abs(s)
        if a > peak:
            peak = a
        total += s * s
    return peak, math.sqrt(total / max(1, len(samples)))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def integrated_lufs(path):
    """ITU-R BS.1770 integrated loudness via ffmpeg's ebur128. None if unavailable."""
    if shutil.which("ffmpeg") is None:
        return None
    err = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                          "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    hits = re.findall(r"^\s*I:\s*(-?\d+(?:\.\d+)?) LUFS", err, flags=re.M)
    return float(hits[-1]) if hits else None


def write_gained_copy(src, dst, gain_db):
    """A copy of `src` with a static gain, as 32-bit float (never touches `src`)."""
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                    "-af", f"volume={gain_db:.4f}dB", "-c:a", "pcm_f32le", str(dst)], check=True)


# ── reopen ─────────────────────────────────────────────────────────────────────────
def preset_rows(snapshot, track_id):
    for t in snapshot.get("tracks", []):
        if t.get("id") == track_id:
            return [p for p in t.get("plugins", []) if p.get("preset", {}).get("id") == PRESET_ID], t
    return [], None


def cmd_reopen(args):
    binary, preset = Path(args.bin), preset_path(args.bin)
    work = Path(args.work or (HARNESS_ROOT / "vocal-preset-reopen-work"))
    work.mkdir(parents=True, exist_ok=True)
    checks = []

    def check(ok, what):
        checks.append(ok)
        print(("  ok   " if ok else "  FAIL ") + what)

    check(preset.is_file(), f"bundled preset is staged in the app under test ({preset})")
    if not preset.is_file():
        return 1

    tone = work / "vp-reopen-tone.wav"
    write_stepped_tone(tone, [0.03, 0.125, 0.5, 0.98])
    tone_sha = sha256(tone)
    a_wav, b_wav = work / "vp-reopen-a.wav", work / "vp-reopen-b.wav"
    export = lambda f: {"command": "export_audio", "args": {"file": str(f), "format": "wav", "bitDepth": 32,
                                                            "sampleRate": 48000, "range": "full"}}

    rc1, first, err1 = run_script(binary, "vocal-preset-reopen-a", [
        {"command": "new_project", "args": {"name": "vp-reopen"}},
        {"command": "create_track", "args": {"name": "Vox"}, "capture": {"T": "trackId"}},
        {"command": "import_clip", "args": {"trackId": "${T}", "file": str(tone)}},
        {"command": "apply_track_preset", "args": {"trackId": "${T}", "file": str(preset)}},
        {"command": "__snapshot", "args": {"label": "applied"}},
        export(a_wav),
        {"command": "save"},
    ], work)
    applied = result(first, "apply_track_preset")
    snap1 = result(first, "__snapshot").get("data", {})
    track_id = applied.get("data", {}).get("trackId", "")
    project = snap1.get("session", {}).get("editFile", "")
    check(rc1 == 0 and applied.get("ok") is True, f"process 1: preset applied (rc {rc1})" + ("" if rc1 == 0 else f"\n{err1}"))
    check(result(first, "save").get("ok") is True and Path(project).is_file(), f"process 1: project saved ({project})")
    rows1, track1 = preset_rows(snap1, track_id)
    check(len(rows1) == 2, "process 1: two preset rows on the target track")

    rc2, second, err2 = run_script(binary, "vocal-preset-reopen-b", [
        {"command": "open_project", "args": {"file": project}},
        {"command": "__wait", "args": {"ms": 400}},
        {"command": "__snapshot", "args": {"label": "reopened"}},
        export(b_wav),
        # Re-applying in the new process must recognise its own chain: a no-op, not a second one.
        {"command": "apply_track_preset", "args": {"trackId": track_id, "file": str(preset)}},
        {"command": "__snapshot", "args": {"label": "reapplied"}},
    ], work)
    snap2 = result(second, "__snapshot", 0).get("data", {})
    snap3 = result(second, "__snapshot", 1).get("data", {})
    check(rc2 == 0 and result(second, "open_project").get("ok") is True,
          f"process 2 (fresh process): project opened (rc {rc2})" + ("" if rc2 == 0 else f"\n{err2}"))
    rows2, track2 = preset_rows(snap2, track_id)
    check(track2 is not None, "fresh process: the target track keeps its id")
    check(len(rows2) == 2 and [r["type"] for r in rows2] == ["highpass", "compressor"],
          "fresh process: both stages are present, high-pass first")
    check(json.dumps(rows1, sort_keys=True) == json.dumps(rows2, sort_keys=True),
          "fresh process: stage order, parameter values, display strings, bypass and ownership tags are identical")
    if track1 and track2:
        check(json.dumps(track1.get("clips"), sort_keys=True) == json.dumps(track2.get("clips"), sort_keys=True),
              "fresh process: the clip (timing, source) is identical")
    reapplied = result(second, "apply_track_preset")
    check(reapplied.get("ok") is True and reapplied.get("data", {}).get("changed") is False,
          "fresh process: re-applying is a no-op (ownership survived the reopen)")
    check(len(preset_rows(snap3, track_id)[0]) == 2, "fresh process: still exactly two preset rows after the re-apply")

    try:
        sr_a, ch_a, a = read_float_wav(a_wav)
        sr_b, ch_b, b = read_float_wav(b_wav)
        same_shape = (sr_a, ch_a, len(a)) == (sr_b, ch_b, len(b))
        residual = max((abs(x - y) for x, y in zip(a, b)), default=1.0) if same_shape else 1.0
        peak_a, _ = peak_and_rms(a)
        check(same_shape and peak_a > 0.01, "renders from both processes have the same shape and are not silent")
        check(residual <= 3.2e-5, f"render equivalence: peak residual {db(residual):.1f} dBFS (tolerance -90)")
    except (OSError, ValueError) as e:
        check(False, f"renders readable ({e})")

    check(sha256(tone) == tone_sha, "the source recording was not modified")

    for leaf in ("vocal-preset-reopen-a", "vocal-preset-reopen-b"):
        shutil.rmtree(HARNESS_ROOT / leaf, ignore_errors=True)
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
    print(f"===== reopen: {sum(checks)}/{len(checks)} checks passed =====")
    return 0 if all(checks) else 1


# ── audition ───────────────────────────────────────────────────────────────────────
def cmd_audition(args):
    binary, preset = Path(args.bin), preset_path(args.bin)
    source_dir, out_dir = Path(args.source_dir), Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = out_dir / "_work"
    work.mkdir(exist_ok=True)
    sources = [source_dir / n for n in args.files]
    missing = [str(s) for s in sources if not s.is_file()]
    if missing or not preset.is_file():
        print("audition: NOT RUN — missing " + ", ".join(missing or [str(preset)]))
        return 2
    if shutil.which("ffmpeg") is None:
        print("audition: NOT RUN — ffmpeg is required for BS.1770 loudness matching")
        return 2

    before = {s.name: sha256(s) for s in sources}
    rows, failures = [], 0
    for source in sources:
        for offset in args.levels:
            tag = f"{source.stem.replace(' ', '-')}_{offset:+.0f}dB"
            dry, wet = out_dir / f"{tag}_dry.wav", out_dir / f"{tag}_processed.wav"
            matched = out_dir / f"{tag}_processed_matched.wav"
            export = lambda f: {"command": "export_audio", "args": {"file": str(f), "format": "wav", "bitDepth": 32,
                                                                    "sampleRate": 48000, "range": "full"}}
            rc, lines, err = run_script(binary, "vocal-preset-audition", [
                {"command": "new_project", "args": {"name": "vp-audition"}},
                {"command": "create_track", "args": {"name": "Vox"}, "capture": {"T": "trackId"}},
                {"command": "import_clip", "args": {"trackId": "${T}", "file": str(source)}, "capture": {"C": "clipId"}},
                # Input level is varied with CLIP GAIN inside the session — the source file is never rewritten.
                {"command": "set_clip_gain", "args": {"clipId": "${C}", "gainDb": offset}},
                export(dry),
                {"command": "apply_track_preset", "args": {"trackId": "${T}", "file": str(preset)}},
                export(wet),
            ], work)
            ok = rc == 0 and result(lines, "apply_track_preset").get("ok") is True and dry.is_file() and wet.is_file()
            if not ok:
                failures += 1
                # The app's own reason, not just its stderr. "export render stalled" on a
                # freshly imported file almost always means the SOURCE carries tempo
                # metadata (a BPM token in its name, or an ACID chunk in a WAV) or is not a
                # plain WAV, so the app queued a stretch/convert proxy that a headless run
                # never finishes. Import a metadata-free PCM WAV copy instead.
                reasons = [f"{l.get('command')}: {l.get('error')}" for l in lines if l.get("ok") is False]
                print(f"  FAIL {tag}: render failed (rc {rc}) — " + ("; ".join(reasons) or err.strip()[-300:]))
                continue
            _, _, d = read_float_wav(dry)
            _, _, w = read_float_wav(wet)
            dp, dr = peak_and_rms(d)
            wp, wr = peak_and_rms(w)
            dl, wl = integrated_lufs(dry), integrated_lufs(wet)
            match_db = (dl - wl) if (dl is not None and wl is not None) else None
            if match_db is not None:
                write_gained_copy(wet, matched, match_db)
            finite = all(math.isfinite(x) for x in w)
            rows.append({
                "source": source.name, "inputOffsetDb": offset,
                "dry": {"peakDb": round(db(dp), 2), "rmsDb": round(db(dr), 2), "crestDb": round(db(dp) - db(dr), 2), "lufs": dl},
                "processed": {"peakDb": round(db(wp), 2), "rmsDb": round(db(wr), 2), "crestDb": round(db(wp) - db(wr), 2), "lufs": wl},
                "crestChangeDb": round((db(wp) - db(wr)) - (db(dp) - db(dr)), 2),
                "matchGainDb": None if match_db is None else round(match_db, 2),
                "processedPeakExceedsDry": wp > dp + 1e-6, "finite": finite,
                "files": {"dry": dry.name, "processed": wet.name, "processedMatched": matched.name if match_db is not None else None},
            })
            print(f"  ok   {tag}: crest {rows[-1]['dry']['crestDb']} -> {rows[-1]['processed']['crestDb']} dB, "
                  f"match gain {rows[-1]['matchGainDb']} dB")

    after = {s.name: sha256(s) for s in sources}
    untouched = before == after
    report = {
        "preset": PRESET_ID, "presetFileSha256": sha256(preset), "binary": str(binary),
        "method": ("Each source is imported into a throwaway harness session, exported dry, then exported again after "
                   "apply_track_preset. Input level is varied by clip gain in the session. The matched copy is the "
                   "processed render with ONE static gain so its integrated loudness (ITU-R BS.1770 via ffmpeg "
                   "ebur128) equals the dry render's; the gain is applied to the render copy, never to a source."),
        "sourcesUntouched": untouched, "sourceSha256": before, "renders": rows,
        "listening": "NOT RUN — these files are prepared for a human listening pass; none has taken place.",
    }
    (out_dir / "audition-report.json").write_text(json.dumps(report, indent=2) + "\n")
    shutil.rmtree(HARNESS_ROOT / "vocal-preset-audition", ignore_errors=True)
    shutil.rmtree(work, ignore_errors=True)
    print(f"  {'ok  ' if untouched else 'FAIL'} source recordings byte-identical before and after")
    print(f"===== audition: {len(rows)} render pairs written to {out_dir} =====")
    return 0 if (failures == 0 and untouched) else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    r = sub.add_parser("reopen")
    r.add_argument("--bin", required=True)
    r.add_argument("--work")
    r.add_argument("--keep", action="store_true", help="keep the work directory (renders, scripts)")
    a = sub.add_parser("audition")
    a.add_argument("--bin", required=True)
    a.add_argument("--source-dir", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--files", nargs="+", required=True, help="file names inside --source-dir")
    a.add_argument("--levels", nargs="+", type=float, default=[-6.0, 0.0, 6.0], help="input offsets in dB (clip gain)")
    args = p.parse_args()
    return cmd_reopen(args) if args.mode == "reopen" else cmd_audition(args)


if __name__ == "__main__":
    sys.exit(main())
