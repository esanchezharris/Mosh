#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
DEFAULT_BIN = Path("/Applications/Mosh.app/Contents/MacOS/Mosh")
DEFAULT_PROOF = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated" / "default-runtime-generate-proof.jsonl"


def _request(args: argparse.Namespace) -> dict[str, Any]:
    request: dict[str, Any] = {
        "mood": args.mood,
        "tempo": args.tempo,
        "key": args.key,
        "seed": args.seed,
    }
    if args.lead is not None:
        request["lead"] = args.lead
    if args.library_dir:
        request["libraryDir"] = args.library_dir
    if args.palette_manifest:
        request["paletteManifest"] = args.palette_manifest
    return request


def _minimal_env(script: Path, results: Path, session: str) -> dict[str, str]:
    keep = ("HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "SHELL", "LANG", "LC_ALL", "__CF_USER_TEXT_ENCODING")
    env = {key: value for key in keep if (value := os.environ.get(key))}
    env.setdefault("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    env.update(
        {
            "MOSH_RUN_SCRIPT": str(script),
            "MOSH_RUN_SCRIPT_OUT": str(results),
            "MOSH_SELFTEST_SESSION": session,
            "MOSH_NO_AUDIO": "1",
            "MOSH_ENABLE_SA3": "0",
        }
    )
    return env


def _read_results(path: Path, stdout: str) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8") if path.exists() else stdout
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def _row_data(row: dict[str, Any]) -> dict[str, Any]:
    data = row.get("data")
    return data if isinstance(data, dict) else row


def _snapshot_summary(snapshot: dict[str, Any]) -> dict[str, Any]:
    data = _row_data(snapshot)
    tracks = data.get("tracks", [])
    if not isinstance(tracks, list):
        tracks = []
    midi_tracks = []
    midi_clip_count = 0
    note_count = 0
    for track in tracks:
        clips = track.get("clips", []) if isinstance(track, dict) else []
        if not isinstance(clips, list):
            clips = []
        track_has_midi = False
        for clip in clips:
            if not isinstance(clip, dict) or clip.get("type") != "midi":
                continue
            track_has_midi = True
            midi_clip_count += 1
            notes = clip.get("notes", [])
            if isinstance(notes, list):
                note_count += len(notes)
        if track_has_midi and isinstance(track, dict):
            midi_tracks.append(track)
    return {
        "trackCount": len(tracks),
        "midiTrackCount": len(midi_tracks),
        "midiClipCount": midi_clip_count,
        "noteCount": note_count,
    }


def _safe_generate_summary(row: dict[str, Any], *, used_explicit_runtime_args: bool) -> dict[str, Any]:
    data = _row_data(row)
    provenance = data.get("provenance", {})
    sources = provenance.get("sources", {}) if isinstance(provenance, dict) else {}
    if not isinstance(sources, dict):
        sources = {}
    return {
        "ok": bool(row.get("ok")),
        "command": row.get("command", "generate_beat_recipe"),
        "recipeId": data.get("recipeId", ""),
        "commandCount": int(data.get("commandCount") or 0),
        "appliedCount": int(data.get("appliedCount") or 0),
        "unresolved": data.get("unresolved", []),
        "sources": sources,
        "usedExplicitRuntimeArgs": used_explicit_runtime_args,
    }


def _check(condition: bool, label: str, failures: list[str], detail: str = "") -> None:
    status = "  ok   " if condition else "  FAIL "
    suffix = "" if condition or not detail else f"  [{detail}]"
    print(f"{status}{label}{suffix}")
    if not condition:
        failures.append(label)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify installed Mosh generate_beat_recipe through the native command surface")
    parser.add_argument("--bin", default=str(DEFAULT_BIN), help="Mosh binary to drive")
    parser.add_argument("--mood", default="dark")
    parser.add_argument("--tempo", type=float, default=140.0)
    parser.add_argument("--key", default="F minor")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--lead", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--library-dir", default="", help="optional explicit recipe library; omitted proves bundled/default runtime")
    parser.add_argument("--palette-manifest", default="", help="optional explicit palette manifest; omitted proves bundled/default runtime")
    parser.add_argument("--min-midi-tracks", type=int, default=4)
    parser.add_argument("--proof-out", default=str(DEFAULT_PROOF), help="safe compact JSONL proof path")
    parser.add_argument("--session", default="generate-command-check")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args(argv)

    bin_path = Path(args.bin)
    if not bin_path.is_file():
        print(f"FAIL missing Mosh binary: {bin_path}", file=sys.stderr)
        return 1

    request = _request(args)
    commands = [
        {"command": "generate_beat_recipe", "args": request},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    used_explicit_runtime_args = bool(args.library_dir or args.palette_manifest)

    with tempfile.TemporaryDirectory(prefix="mosh-generate-command-") as td:
        tmp = Path(td)
        script = tmp / "script.jsonl"
        results_path = tmp / "results.jsonl"
        script.write_text("\n".join(json.dumps(cmd, sort_keys=True) for cmd in commands) + "\n", encoding="utf-8")
        env = _minimal_env(script, results_path, args.session)
        proc = subprocess.run(
            [str(bin_path), "--run-script"],
            env=env,
            capture_output=True,
            text=True,
            timeout=args.timeout,
        )
        rows = _read_results(results_path, proc.stdout)

    generate_rows = [row for row in rows if row.get("command") == "generate_beat_recipe"]
    snapshot_rows = [row for row in rows if row.get("command") == "__snapshot"]
    failures: list[str] = []

    _check(proc.returncode == 0, "run-script exited 0", failures, f"code={proc.returncode} stderr={proc.stderr.strip()[:300]}")
    _check(len(generate_rows) == 1, "one generate_beat_recipe result", failures, f"rows={len(generate_rows)}")
    _check(len(snapshot_rows) == 1, "one snapshot result", failures, f"rows={len(snapshot_rows)}")

    safe_rows: list[dict[str, Any]] = []
    if generate_rows:
        gen_summary = _safe_generate_summary(generate_rows[0], used_explicit_runtime_args=used_explicit_runtime_args)
        safe_rows.append(gen_summary)
        unresolved = gen_summary.get("unresolved", [])
        sources = gen_summary.get("sources", {})
        distinct_sources = {value for value in sources.values() if isinstance(value, str)}
        _check(gen_summary["ok"], "generate_beat_recipe returned ok", failures)
        _check(gen_summary["commandCount"] > 0, "generated program had commands", failures)
        _check(gen_summary["appliedCount"] == gen_summary["commandCount"], "all generated commands applied", failures)
        _check(unresolved == [], "generated program had no unresolved refs", failures, str(unresolved))
        _check("808" in sources, "provenance includes 808 source", failures)
        _check(len(distinct_sources) > 1, "provenance shows cross-source recombination", failures, str(sources))
    if snapshot_rows:
        snap_summary = {"ok": bool(snapshot_rows[0].get("ok")), "command": "__snapshot", **_snapshot_summary(snapshot_rows[0])}
        safe_rows.append(snap_summary)
        _check(snap_summary["ok"], "snapshot returned ok", failures)
        _check(snap_summary["midiTrackCount"] >= args.min_midi_tracks, "snapshot has enough MIDI-bearing tracks", failures, str(snap_summary))
        _check(snap_summary["noteCount"] > 0, "snapshot contains MIDI notes", failures, str(snap_summary))

    if args.proof_out:
        proof = Path(args.proof_out)
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text("\n".join(json.dumps(row, sort_keys=True) for row in safe_rows) + "\n", encoding="utf-8")
        print(f"  .. wrote safe proof {proof}")

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}  ({len(failures)} failure(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
