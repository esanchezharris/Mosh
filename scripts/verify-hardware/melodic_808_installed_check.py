#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf

REPO = Path(__file__).resolve().parents[2]
DEFAULT_BIN = Path("/Applications/Mosh.app/Contents/MacOS/Mosh")
DEFAULT_OUT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated" / "melodic-808-installed-proof.json"


def _write_test_808(path: Path, *, sr: int = 44100, seconds: float = 4.0) -> None:
    samples = int(sr * seconds)
    t = np.arange(samples, dtype=np.float64) / sr
    y = 0.42 * np.sin(2.0 * math.pi * 55.0 * t)
    fade = min(int(0.02 * sr), samples // 8)
    if fade:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float64)
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
    sf.write(str(path), y.astype(np.float32), sr)


def _commands(sample: Path, out_wav: Path, *, mode: str, note_beats: float) -> list[dict[str, Any]]:
    return [
        {"command": "set_tempo", "args": {"bpm": 120.0}},
        {"command": "create_track", "args": {"name": f"{mode} 808", "type": "audio"}, "capture": {"T0": "trackId"}},
        {
            "command": "assign_sample",
            "args": {
                "trackId": "${T0}",
                "note": 36,
                "mode": mode,
                "file": str(sample),
            },
        },
        {
            "command": "add_midi_clip",
            "args": {
                "trackId": "${T0}",
                "start": 0,
                "length": 4.0,
                "name": f"{mode} 808",
                "notes": [{"pitch": 36, "start": 0.0, "length": note_beats, "velocity": 110}],
            },
            "capture": {"C0": "clipId"},
        },
        {"command": "__snapshot", "args": {"label": "after_midi"}},
        {"command": "export_audio", "args": {"file": str(out_wav)}},
    ]


def _run_case(bin_path: Path, sample: Path, work: Path, *, mode: str, note_beats: float, timeout: int) -> dict[str, Any]:
    case_dir = work / f"{mode}-{str(note_beats).replace('.', '_')}"
    case_dir.mkdir(parents=True, exist_ok=True)
    script = case_dir / "script.jsonl"
    results_path = case_dir / "results.jsonl"
    out_wav = case_dir / "render.wav"
    commands = _commands(sample, out_wav, mode=mode, note_beats=note_beats)
    script.write_text("\n".join(json.dumps(command, sort_keys=True) for command in commands) + "\n", encoding="utf-8")
    env = dict(
        os.environ,
        MOSH_RUN_SCRIPT=str(script),
        MOSH_RUN_SCRIPT_OUT=str(results_path),
        MOSH_SESSION_DIR=str(case_dir),
        MOSH_NO_AUDIO="1",
    )
    proc = subprocess.run([str(bin_path), "--run-script"], env=env, capture_output=True, text=True, timeout=timeout, check=False)
    rows = []
    if results_path.exists():
        rows = [json.loads(line) for line in results_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assign_rows = [row for row in rows if row.get("command") == "assign_sample"]
    assign = assign_rows[-1] if assign_rows else {}
    assign_data = assign.get("data") if isinstance(assign.get("data"), dict) else {}
    snapshot_rows = [row for row in rows if row.get("command") == "__snapshot"]
    snapshot = snapshot_rows[-1].get("data", {}) if snapshot_rows and isinstance(snapshot_rows[-1].get("data"), dict) else {}
    audio = _measure_audio(out_wav)
    failed = [
        {"command": row.get("command"), "error": row.get("error") or (row.get("data") or {}).get("error")}
        for row in rows
        if row.get("ok") is False
    ]
    tracks = snapshot.get("tracks") if isinstance(snapshot.get("tracks"), list) else []
    midi_clip_count = 0
    for track in tracks:
        clips = track.get("clips") if isinstance(track, dict) and isinstance(track.get("clips"), list) else []
        midi_clip_count += sum(1 for clip in clips if isinstance(clip, dict) and clip.get("type") == "midi")
    return {
        "mode": mode,
        "note_beats": note_beats,
        "note_seconds": round(note_beats * 0.5, 4),
        "returncode": proc.returncode,
        "failed_commands": failed,
        "assign_sample": {
            "ok": bool(assign.get("ok")),
            "mode": assign_data.get("mode", ""),
            "sounds": int(assign_data.get("sounds") or 0),
            "note": int(assign_data.get("note") or -1),
        },
        "snapshot": {
            "track_count": len(tracks),
            "midi_clip_count": midi_clip_count,
        },
        "audio": audio,
    }


def _measure_audio(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.stat().st_size == 0:
        return {"present": False, "rms": 0.0, "active_seconds": 0.0, "seconds": 0.0}
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if mono.size == 0:
        return {"present": False, "rms": 0.0, "active_seconds": 0.0, "seconds": 0.0}
    rms = float(np.sqrt(np.mean(mono.astype(np.float64) ** 2)))
    window = max(1, int(sr * 0.02))
    power = np.convolve(np.square(mono.astype(np.float64)), np.ones(window) / window, mode="same")
    active = np.sqrt(power) > 0.02
    if np.any(active):
        idx = np.flatnonzero(active)
        active_seconds = float((idx[-1] - idx[0] + 1) / sr)
    else:
        active_seconds = 0.0
    return {
        "present": True,
        "rms": round(rms, 8),
        "active_seconds": round(active_seconds, 4),
        "seconds": round(float(mono.size / sr), 4),
    }


def _ok(report: dict[str, Any]) -> tuple[bool, list[str]]:
    failures: list[str] = []
    cases = {case["name"]: case for case in report["cases"]}
    melodic_short = cases["melodic_short"]
    melodic_long = cases["melodic_long"]
    drum_short = cases["drum_short"]

    for name, case in cases.items():
        if case["returncode"] != 0:
            failures.append(f"{name}: app returned {case['returncode']}")
        if case["failed_commands"]:
            failures.append(f"{name}: failed commands present")
        if not case["assign_sample"]["ok"]:
            failures.append(f"{name}: assign_sample failed")
        if case["assign_sample"]["sounds"] != 1:
            failures.append(f"{name}: expected exactly one sampler sound")
        if case["snapshot"]["track_count"] != 1 or case["snapshot"]["midi_clip_count"] != 1:
            failures.append(f"{name}: expected one track and one MIDI clip")
        if not case["audio"]["present"] or case["audio"]["rms"] <= 1e-4:
            failures.append(f"{name}: render is silent or missing")

    if melodic_short["assign_sample"]["mode"] != "melodic" or melodic_long["assign_sample"]["mode"] != "melodic":
        failures.append("melodic cases did not echo mode=melodic")
    if drum_short["assign_sample"]["mode"] != "drum":
        failures.append("drum control did not echo mode=drum")

    short_active = float(melodic_short["audio"]["active_seconds"])
    long_active = float(melodic_long["audio"]["active_seconds"])
    drum_active = float(drum_short["audio"]["active_seconds"])
    if not short_active < 1.0:
        failures.append(f"melodic short note did not gate quickly enough: {short_active:.3f}s")
    if not long_active > 1.5:
        failures.append(f"melodic long note did not sustain: {long_active:.3f}s")
    if not long_active > short_active + 1.0:
        failures.append("melodic long/short duration separation too small")
    if not drum_active > short_active + 1.0:
        failures.append("drum one-shot control did not ring longer than melodic short note")
    return not failures, failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify installed Mosh melodic 808 sampler behavior")
    parser.add_argument("--bin", default=str(DEFAULT_BIN))
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args(argv)

    bin_path = Path(args.bin)
    if not bin_path.is_file():
        raise SystemExit(f"Mosh binary not found: {bin_path}")

    with tempfile.TemporaryDirectory(prefix="mosh-melodic-808-") as td:
        work = Path(td)
        sample = work / "synthetic-808.wav"
        _write_test_808(sample)
        cases = [
            {"name": "melodic_short", **_run_case(bin_path, sample, work, mode="melodic", note_beats=0.5, timeout=args.timeout)},
            {"name": "melodic_long", **_run_case(bin_path, sample, work, mode="melodic", note_beats=4.0, timeout=args.timeout)},
            {"name": "drum_short", **_run_case(bin_path, sample, work, mode="drum", note_beats=0.5, timeout=args.timeout)},
        ]

    report = {
        "schema_version": 1,
        "binary": "/Applications/Mosh.app" if bin_path == DEFAULT_BIN else "custom",
        "binary_mtime": int(bin_path.stat().st_mtime),
        "sample": "synthetic 55Hz 4s sine, generated at runtime",
        "claims": {
            "melodic_mode_echoed": True,
            "one_sampler_sound": True,
            "short_note_gated": True,
            "long_note_sustained": True,
            "drum_control_rings_longer": True,
        },
        "cases": cases,
    }
    ok, failures = _ok(report)
    report["ok"] = ok
    report["failures"] = failures

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = {
        "ok": ok,
        "failures": failures,
        "binary": report["binary"],
        "cases": [
            {
                "name": case["name"],
                "mode": case["mode"],
                "note_seconds": case["note_seconds"],
                "sounds": case["assign_sample"]["sounds"],
                "active_seconds": case["audio"]["active_seconds"],
                "rms": case["audio"]["rms"],
            }
            for case in cases
        ],
        "out": str(out.relative_to(REPO)) if out.resolve().is_relative_to(REPO) else "outside-repo",
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
