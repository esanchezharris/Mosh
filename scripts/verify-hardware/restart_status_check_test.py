#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import csv
import importlib.util
import io
import json
import tempfile
import wave
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("restart_status_check", HERE / "restart_status_check.py")
assert SPEC and SPEC.loader
RESTART = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESTART)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        raise AssertionError(name)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(b"\0\0" * 256)


def _write_scorecard(path: Path, *, complete: bool) -> None:
    fields = list(RESTART.gate_c_pack_check.REQUIRED_COLUMNS)
    rows: list[dict[str, str]] = []
    for group in ("01", "02", "03", "04", "05", "06"):
        for label in ("A", "B", "C"):
            rows.append(
                {
                    "group": group,
                    "blind_label": label,
                    "file": f"g{group}_{label}.wav",
                    "prompt": f"prompt {group}",
                    "musically_distinct_1_5": "4" if complete else "",
                    "would_keep_1_5": "5" if complete else "",
                    "notes": "",
                }
            )
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _write_gate_c_pack(root: Path, *, complete: bool) -> Path:
    pack = root / "gate-c"
    pack.mkdir(parents=True)
    (pack / "README.md").write_text("# Gate C blind listening pack\n", encoding="utf-8")
    _write_scorecard(pack / "scorecard.csv", complete=complete)
    _write_json(
        pack / "answer_key.json",
        {
            "private_fixture_note": "/Users/example/private/palette/kick.wav",
            "labels": [],
        },
    )
    for group in ("01", "02", "03", "04", "05", "06"):
        for label in ("A", "B", "C"):
            _write_wav(pack / f"g{group}_{label}.wav")
    return pack


def _write_restart_root(root: Path) -> None:
    _write_json(
        root / "gate-a-midi-audit.json",
        {
            "ok": True,
            "palette_manifest": "/Users/example/private/palette/manifest.json",
            "corpus_gate": {
                "checked": 48,
                "roles": {"808": 10, "kick": 2, "hat": 8, "pad": 6},
            },
            "requirements": [{"name": name, "ok": True} for name in RESTART.REQUIRED_GATE_A_REQUIREMENTS],
            "render_rows": [
                {
                    "provenance": {
                        "samples": {
                            "808": "/Users/example/private/palette/808.wav",
                        }
                    }
                }
            ],
        },
    )
    _write_json(
        root / "promotion-packet.json",
        {
            "safe_report": {
                "raw_media_included": False,
                "raw_source_paths_included": False,
                "source_path_classes_only": True,
            },
            "promotion_readiness": {
                "staged_runtime_safe": True,
                "repo_promotion_safe_now": False,
                "tracked_source_path_risks": 0,
                "owner_source_policy_required": True,
                "owner_gate_c_required": True,
            },
        },
    )
    (root / "default-runtime-generate-proof.jsonl").write_text(
        "\n".join(
            json.dumps(row, sort_keys=True)
            for row in [
                {
                    "scenario": "success",
                    "command": "generate_beat_recipe",
                    "ok": True,
                    "appliedCount": 25,
                    "commandCount": 25,
                    "unresolved": [],
                    "usedExplicitRuntimeArgs": False,
                },
                {
                    "scenario": "success",
                    "command": "__snapshot",
                    "ok": True,
                    "midiTrackCount": 8,
                    "noteCount": 338,
                },
                {
                    "scenario": "missing-library-failure",
                    "command": "generate_beat_recipe",
                    "ok": True,
                    "errorKind": "recipe-library-missing",
                    "noSideEffects": True,
                },
                {
                    "scenario": "partial-apply-rollback",
                    "command": "generate_beat_recipe",
                    "ok": True,
                    "errorKind": "assign-sample-file-missing",
                    "noSideEffects": True,
                },
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    _write_json(
        root / "rescore-catalog.json",
        {
            "summary": {
                "total": 31,
                "by_status": {"usable": 14, "weak": 3, "reject": 14},
            }
        },
    )
    (root / "catalog-midi-first.sqlite").write_bytes(b"sqlite placeholder")
    (root / "teardown_jobs-midi-first.jsonl").write_text("{}\n{}\n", encoding="utf-8")
    (root / "teardown_jobs-midi-ingredients.jsonl").write_text("{}\n", encoding="utf-8")


def _main_quiet(args: list[str]) -> int:
    with contextlib.redirect_stdout(io.StringIO()):
        return int(RESTART.main(args))


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        root = base / "r7"
        stop = base / "docs" / "auto-loop" / "STOP"
        stop.parent.mkdir(parents=True)
        stop.write_text("stop\n", encoding="utf-8")
        _write_restart_root(root)
        incomplete_pack = _write_gate_c_pack(base / "incomplete", complete=False)

        status = RESTART.build_status(root, gate_c_pack=incomplete_pack, stop_path=stop)
        payload = json.dumps(status, sort_keys=True)
        check("repo is ready when only owner blockers remain",
              status["repoReadyForOwnerDecision"] and not status["repoFailures"],
              payload)
        check("owner blockers name source policy and Gate C scoring",
              status["ownerBlockers"] == ["gate_c_scorecard", "source_policy"],
              payload)
        check("status preserves Gate C blindness",
              status["gateC"]["blindPreserved"] and not status["gateC"]["answerKeyRead"],
              payload)
        check("safe status omits private fixture paths",
              "/Users/example/private" not in payload,
              payload)
        check("CLI fails by default while owner blockers remain",
              _main_quiet(["--root", str(root), "--gate-c-pack", str(incomplete_pack), "--stop", str(stop)]) == 1)
        check("CLI can pass with explicit owner-blocker allowance",
              _main_quiet([
                  "--root", str(root),
                  "--gate-c-pack", str(incomplete_pack),
                  "--stop", str(stop),
                  "--allow-owner-blockers",
              ]) == 0)

        bad_root = base / "bad-r7"
        _write_restart_root(bad_root)
        (bad_root / "default-runtime-generate-proof.jsonl").write_text("{}", encoding="utf-8")
        bad_status = RESTART.build_status(bad_root, gate_c_pack=incomplete_pack, stop_path=stop)
        check("repo-side proof failures are not owner blockers",
              bad_status["repoFailures"] and not bad_status["repoReadyForOwnerDecision"],
              json.dumps(bad_status, sort_keys=True))

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
