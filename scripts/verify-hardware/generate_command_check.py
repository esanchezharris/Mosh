#!/usr/bin/env python3
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import subprocess
import sys
import tempfile
import threading
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


def _minimal_env(script: Path, results: Path, session: str, extra_env: dict[str, str] | None = None) -> dict[str, str]:
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
    if extra_env:
        env.update(extra_env)
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


def _run_commands(
    bin_path: Path,
    commands: list[dict[str, Any]],
    *,
    session: str,
    timeout: int,
    extra_env: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], list[dict[str, Any]]]:
    with tempfile.TemporaryDirectory(prefix="mosh-generate-command-") as td:
        tmp = Path(td)
        script = tmp / "script.jsonl"
        results_path = tmp / "results.jsonl"
        script.write_text("\n".join(json.dumps(cmd, sort_keys=True) for cmd in commands) + "\n", encoding="utf-8")
        env = _minimal_env(script, results_path, session, extra_env=extra_env)
        proc = subprocess.run(
            [str(bin_path), "--run-script"],
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        rows = _read_results(results_path, proc.stdout)
    return proc, rows


def _row_data(row: dict[str, Any]) -> dict[str, Any]:
    data = row.get("data")
    return data if isinstance(data, dict) else row


def _partial_apply_program() -> dict[str, Any]:
    return {
        "ok": True,
        "recipeId": "rollback_probe",
        "program": {
            "commands": [
                {
                    "command": "create_track",
                    "args": {"name": "Rollback Probe", "type": "drum"},
                    "capture": {"T0": "trackId"},
                },
                {
                    "command": "assign_sample",
                    "args": {
                        "trackId": "${T0}",
                        "note": 36,
                        "mode": "drum",
                        "file": "/tmp/mosh-rollback-probe-missing-sample.wav",
                    },
                },
            ],
            "unresolved": [],
        },
        "provenance": {"sources": {"rollback": "fake-service"}},
    }


class _FakeRecipeHandler(BaseHTTPRequestHandler):
    server_version = "MoshRecipeFake/1"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True, "build": "fake-recipe-rollback"})
            return
        self._send_json(404, {"ok": False, "error": "not-found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/generate_recipe":
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length:
                self.rfile.read(length)
            self._send_json(200, _partial_apply_program())
            return
        self._send_json(404, {"ok": False, "error": "not-found"})

    def log_message(self, fmt: str, *args: Any) -> None:
        return


class _FakeRecipeServer:
    def __enter__(self) -> "_FakeRecipeServer":
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeRecipeHandler)
        self.port = int(self.httpd.server_address[1])
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


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


def _error_kind(row: dict[str, Any]) -> str:
    data = _row_data(row)
    raw = str(row.get("error") or data.get("error") or "")
    if "recipe library missing" in raw:
        return "recipe-library-missing"
    if "assign_sample" in raw and "file not found" in raw:
        return "assign-sample-file-missing"
    if raw:
        return "error"
    return "none"


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
    parser.add_argument("--skip-failure-check", action="store_true", help="skip the missing-library no-side-effect check")
    parser.add_argument("--skip-rollback-check", action="store_true", help="skip the fake-service partial-apply rollback check")
    args = parser.parse_args(argv)

    bin_path = Path(args.bin)
    if not bin_path.is_file():
        print(f"FAIL missing Mosh binary: {bin_path}", file=sys.stderr)
        return 1

    request = _request(args)
    success_commands = [
        {"command": "generate_beat_recipe", "args": request},
        {"command": "__snapshot", "args": {"label": "after"}},
    ]
    used_explicit_runtime_args = bool(args.library_dir or args.palette_manifest)

    proc, rows = _run_commands(bin_path, success_commands, session=f"{args.session}-success", timeout=args.timeout)

    generate_rows = [row for row in rows if row.get("command") == "generate_beat_recipe"]
    snapshot_rows = [row for row in rows if row.get("command") == "__snapshot"]
    failures: list[str] = []

    _check(proc.returncode == 0, "run-script exited 0", failures, f"code={proc.returncode} stderr={proc.stderr.strip()[:300]}")
    _check(len(generate_rows) == 1, "one generate_beat_recipe result", failures, f"rows={len(generate_rows)}")
    _check(len(snapshot_rows) == 1, "one snapshot result", failures, f"rows={len(snapshot_rows)}")

    safe_rows: list[dict[str, Any]] = []
    if generate_rows:
        gen_summary = _safe_generate_summary(generate_rows[0], used_explicit_runtime_args=used_explicit_runtime_args)
        gen_summary["scenario"] = "success"
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
        snap_summary = {"scenario": "success", "ok": bool(snapshot_rows[0].get("ok")), "command": "__snapshot", **_snapshot_summary(snapshot_rows[0])}
        safe_rows.append(snap_summary)
        _check(snap_summary["ok"], "snapshot returned ok", failures)
        _check(snap_summary["midiTrackCount"] >= args.min_midi_tracks, "snapshot has enough MIDI-bearing tracks", failures, str(snap_summary))
        _check(snap_summary["noteCount"] > 0, "snapshot contains MIDI notes", failures, str(snap_summary))

    if not args.skip_failure_check:
        missing_library = f"/tmp/mosh-missing-recipe-library-{os.getpid()}"
        failure_request = dict(request)
        failure_request["libraryDir"] = missing_library
        failure_commands = [
            {"command": "__snapshot", "args": {"label": "before_failure"}},
            {"command": "generate_beat_recipe", "args": failure_request},
            {"command": "__snapshot", "args": {"label": "after_failure"}},
        ]
        fail_proc, fail_rows = _run_commands(bin_path, failure_commands, session=f"{args.session}-failure", timeout=args.timeout)
        fail_generate_rows = [row for row in fail_rows if row.get("command") == "generate_beat_recipe"]
        fail_snapshot_rows = [row for row in fail_rows if row.get("command") == "__snapshot"]
        _check(fail_proc.returncode != 0, "missing-library run-script failed as expected", failures, f"code={fail_proc.returncode}")
        _check(len(fail_generate_rows) == 1, "one failed generate_beat_recipe result", failures, f"rows={len(fail_generate_rows)}")
        _check(len(fail_snapshot_rows) == 2, "failure check has before/after snapshots", failures, f"rows={len(fail_snapshot_rows)}")
        if fail_generate_rows:
            err_kind = _error_kind(fail_generate_rows[0])
            _check(not bool(fail_generate_rows[0].get("ok")), "missing-library generate_beat_recipe returned failure", failures)
            _check(err_kind == "recipe-library-missing", "failure reason is missing recipe library", failures, err_kind)
        else:
            err_kind = "missing-result"
        before_summary = _snapshot_summary(fail_snapshot_rows[0]) if len(fail_snapshot_rows) >= 1 else {}
        after_summary = _snapshot_summary(fail_snapshot_rows[-1]) if len(fail_snapshot_rows) >= 2 else {}
        no_side_effects = before_summary == after_summary and bool(before_summary)
        _check(no_side_effects, "failed generation left snapshot counts unchanged", failures, f"before={before_summary} after={after_summary}")
        safe_rows.append(
            {
                "scenario": "missing-library-failure",
                "ok": err_kind == "recipe-library-missing" and no_side_effects,
                "command": "generate_beat_recipe",
                "errorKind": err_kind,
                "usedExplicitRuntimeArgs": True,
                "before": before_summary,
                "after": after_summary,
                "noSideEffects": no_side_effects,
            }
        )

    if not args.skip_rollback_check:
        rollback_commands = [
            {"command": "__snapshot", "args": {"label": "before_rollback"}},
            {"command": "generate_beat_recipe", "args": {"mood": "rollback", "tempo": 140, "key": "F minor", "seed": 1}},
            {"command": "__snapshot", "args": {"label": "after_rollback"}},
        ]
        with _FakeRecipeServer() as fake:
            rollback_proc, rollback_rows = _run_commands(
                bin_path,
                rollback_commands,
                session=f"{args.session}-rollback",
                timeout=args.timeout,
                extra_env={"MOSH_SERVICE_HOST": "127.0.0.1", "MOSH_SERVICE_PORT": str(fake.port)},
            )
        rollback_generate_rows = [row for row in rollback_rows if row.get("command") == "generate_beat_recipe"]
        rollback_snapshot_rows = [row for row in rollback_rows if row.get("command") == "__snapshot"]
        _check(rollback_proc.returncode != 0, "partial-apply run-script failed as expected", failures, f"code={rollback_proc.returncode}")
        _check(len(rollback_generate_rows) == 1, "one partial-apply generate_beat_recipe result", failures, f"rows={len(rollback_generate_rows)}")
        _check(len(rollback_snapshot_rows) == 2, "partial-apply check has before/after snapshots", failures, f"rows={len(rollback_snapshot_rows)}")
        if rollback_generate_rows:
            rollback_error_kind = _error_kind(rollback_generate_rows[0])
            _check(not bool(rollback_generate_rows[0].get("ok")), "partial-apply generate_beat_recipe returned failure", failures)
            _check(rollback_error_kind == "assign-sample-file-missing", "partial-apply failure reached assign_sample", failures, rollback_error_kind)
        else:
            rollback_error_kind = "missing-result"
        rollback_before = _snapshot_summary(rollback_snapshot_rows[0]) if len(rollback_snapshot_rows) >= 1 else {}
        rollback_after = _snapshot_summary(rollback_snapshot_rows[-1]) if len(rollback_snapshot_rows) >= 2 else {}
        rollback_no_side_effects = rollback_before == rollback_after and bool(rollback_before)
        _check(rollback_no_side_effects, "partial-apply rollback restored snapshot counts", failures, f"before={rollback_before} after={rollback_after}")
        safe_rows.append(
            {
                "scenario": "partial-apply-rollback",
                "ok": rollback_error_kind == "assign-sample-file-missing" and rollback_no_side_effects,
                "command": "generate_beat_recipe",
                "errorKind": rollback_error_kind,
                "before": rollback_before,
                "after": rollback_after,
                "noSideEffects": rollback_no_side_effects,
            }
        )

    if args.proof_out:
        proof = Path(args.proof_out)
        proof.parent.mkdir(parents=True, exist_ok=True)
        proof.write_text("\n".join(json.dumps(row, sort_keys=True) for row in safe_rows) + "\n", encoding="utf-8")
        print(f"  .. wrote safe proof {proof}")

    print(f"\n{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}  ({len(failures)} failure(s))")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
