#!/usr/bin/env python3
from __future__ import annotations

import contextlib
import csv
import io
import importlib.util
import json
import tempfile
import wave
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gate_c_pack_check", HERE / "gate_c_pack_check.py")
assert SPEC and SPEC.loader
GATE_C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE_C)


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        raise AssertionError(name)


def _write_wav(path: Path) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(44100)
        wav.writeframes(b"\0\0" * 256)


def _write_scorecard(path: Path, *, complete: bool) -> None:
    fields = list(GATE_C.REQUIRED_COLUMNS)
    rows: list[dict[str, Any]] = []
    for group in ("01", "02"):
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


def _write_answer_key(path: Path) -> None:
    variants = {
        "A": "exact_r7_backbone",
        "B": "retrieved_adapted_r7",
        "C": "seed_baseline",
    }
    rows = []
    for group in (1, 2):
        for label, variant in variants.items():
            rows.append(
                {
                    "group": group,
                    "blind_label": label,
                    "file": f"g{group:02d}_{label}.wav",
                    "variant": variant,
                    "provenance": {
                        "samples": {
                            "kick": "/Users/example/private/palette/kick.wav",
                        }
                    },
                }
            )
    path.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _make_pack(root: Path, *, complete: bool) -> Path:
    pack = root / "pack"
    pack.mkdir(parents=True)
    (pack / "README.md").write_text("# Gate C blind listening pack\n", encoding="utf-8")
    _write_scorecard(pack / "scorecard.csv", complete=complete)
    _write_answer_key(pack / "answer_key.json")
    for group in ("01", "02"):
        for label in ("A", "B", "C"):
            _write_wav(pack / f"g{group}_{label}.wav")
    return pack


def _main_quiet(args: list[str]) -> int:
    with contextlib.redirect_stdout(io.StringIO()):
        return int(GATE_C.main(args))


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)

        incomplete = _make_pack(root / "incomplete", complete=False)
        status = GATE_C.build_status(incomplete, expect_groups=2, variants_per_group=3)
        check("incomplete scorecard is owner action, not structural failure",
              status["ownerActionRequired"] and not status["structuralErrors"],
              json.dumps(status, sort_keys=True))
        check("default check preserves blind answer key",
              status["blindPreserved"] and not status["answerKeyRead"],
              json.dumps(status, sort_keys=True))

        blocked_reveal = GATE_C.build_status(incomplete, expect_groups=2, variants_per_group=3, reveal=True)
        check("reveal refuses incomplete scorecard without reading answer key",
              blocked_reveal["blindPreserved"] and not blocked_reveal["answerKeyRead"],
              json.dumps(blocked_reveal, sort_keys=True))
        check("blocked reveal explains scorecard-first rule",
              "scorecard incomplete" in blocked_reveal["revealErrors"][0],
              json.dumps(blocked_reveal, sort_keys=True))
        check("CLI fails incomplete scorecard by default",
              _main_quiet(["--pack", str(incomplete), "--expect-groups", "2"]) == 1)
        check("CLI can record incomplete owner-action state",
              _main_quiet(["--pack", str(incomplete), "--expect-groups", "2", "--allow-incomplete"]) == 0)

        complete = _make_pack(root / "complete", complete=True)
        revealed = GATE_C.build_status(complete, expect_groups=2, variants_per_group=3, reveal=True)
        check("complete scorecard can reveal safe variant summary",
              revealed["ok"] and revealed["answerKeyRead"] and not revealed["blindPreserved"],
              json.dumps(revealed, sort_keys=True))
        check("reveal summary omits answer-key provenance and sample paths",
              "/Users/example/private" not in json.dumps(revealed, sort_keys=True),
              json.dumps(revealed, sort_keys=True))
        check("variant summary aggregates all three variants",
              sorted(revealed["reveal"]["variantSummary"]) == ["exact_r7_backbone", "retrieved_adapted_r7", "seed_baseline"],
              json.dumps(revealed, sort_keys=True))

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
