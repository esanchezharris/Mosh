#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated"
REQUIRED_GENERATOR_ROLES = ("808", "kick", "hat", "pad")
DRUM_ROLES = ("kick", "snare", "hat", "clap", "perc")


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _summary_paths(root: Path) -> list[Path]:
    return sorted(path for path in root.glob("*/summary.json") if path.parent.name != "library")


def _path_class(raw_path: str, repo_root: Path) -> str:
    if not raw_path:
        return "missing"
    expanded = Path(os.path.expanduser(raw_path))
    if not expanded.is_absolute():
        expanded = (repo_root / expanded).resolve()
    else:
        expanded = expanded.resolve()
    try:
        rel = expanded.relative_to(repo_root)
    except ValueError:
        return "outside-repo"
    if rel.parts and rel.parts[0] == ".cache":
        return "repo-gitignored-cache"
    return "repo-tracked-risk"


def _display_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO))
    except ValueError:
        return _path_class(str(resolved), REPO)


def _bump(counter: dict[str, int], key: str, amount: int = 1) -> None:
    counter[key] = counter.get(key, 0) + amount


def _read_corpus(root: Path) -> dict[str, Any]:
    groups: list[dict[str, Any]] = []
    counts_by_role: dict[str, int] = {}
    notes_by_role: dict[str, int] = {}
    path_classes: dict[str, int] = {}
    unresolved_by_role: dict[str, int] = {}
    source_role_filters: dict[str, int] = {}
    total = 0

    for summary_path in _summary_paths(root):
        summary = _load_json(summary_path)
        recipes = summary.get("recipes", [])
        group_counts: dict[str, int] = {}
        group_notes: dict[str, int] = {}
        group_path_classes: dict[str, int] = {}
        group_unresolved = 0
        for item in recipes:
            total += 1
            role = str(item.get("role") or "unknown")
            notes = int(item.get("notes") or 0)
            unresolved = int(item.get("unresolved") or 0)
            path_class = _path_class(str(item.get("input") or ""), REPO)
            _bump(counts_by_role, role)
            _bump(notes_by_role, role, notes)
            _bump(path_classes, path_class)
            _bump(group_counts, role)
            _bump(group_notes, role, notes)
            _bump(group_path_classes, path_class)
            if unresolved:
                _bump(unresolved_by_role, role, unresolved)
                group_unresolved += unresolved
            source_filter = str(item.get("source_role_filter") or "")
            if source_filter:
                _bump(source_role_filters, source_filter)
        groups.append(
            {
                "group": summary_path.parent.name,
                "recipe_count": len(recipes),
                "roles": dict(sorted(group_counts.items())),
                "notes_by_role": dict(sorted(group_notes.items())),
                "source_path_classes": dict(sorted(group_path_classes.items())),
                "unresolved_commands": group_unresolved,
            }
        )

    return {
        "recipe_count": total,
        "counts_by_role": dict(sorted(counts_by_role.items())),
        "notes_by_role": dict(sorted(notes_by_role.items())),
        "source_path_classes": dict(sorted(path_classes.items())),
        "unresolved_commands_by_role": dict(sorted(unresolved_by_role.items())),
        "source_role_filters": dict(sorted(source_role_filters.items())),
        "groups": groups,
    }


def _gate_a_status(root: Path, audit_path: Path | None) -> dict[str, Any]:
    candidate = audit_path or (root / "gate-a-midi-audit.json")
    if not candidate.exists():
        return {"available": False, "ok": None, "path": _display_path(candidate)}
    audit = _load_json(candidate)
    requirements = audit.get("requirements", [])
    return {
        "available": True,
        "ok": bool(audit.get("ok")),
        "path": _display_path(candidate),
        "requirements": [
            {"name": item.get("name"), "ok": bool(item.get("ok"))}
            for item in requirements
        ],
    }


def build_packet(root: Path, *, audit_path: Path | None = None) -> dict[str, Any]:
    root = root.resolve()
    corpus = _read_corpus(root)
    gate_a = _gate_a_status(root, audit_path)
    counts = corpus["counts_by_role"]
    required_roles_present = all(int(counts.get(role, 0)) > 0 for role in REQUIRED_GENERATOR_ROLES)
    all_drum_roles_present = all(int(counts.get(role, 0)) > 0 for role in DRUM_ROLES)
    inside_target_size = 30 <= int(corpus["recipe_count"]) <= 50
    tracked_path_risks = int(corpus["source_path_classes"].get("repo-tracked-risk", 0))
    gate_a_ok = gate_a["ok"] is True
    owner_source_policy_required = True
    owner_gate_c_required = True
    repo_promotion_safe_now = (
        inside_target_size
        and required_roles_present
        and all_drum_roles_present
        and gate_a_ok
        and tracked_path_risks == 0
        and not owner_source_policy_required
        and not owner_gate_c_required
    )

    return {
        "schema_version": 1,
        "root": _display_path(root),
        "safe_report": {
            "raw_source_paths_included": False,
            "raw_media_included": False,
            "source_path_classes_only": True,
        },
        "corpus": corpus,
        "gate_a": gate_a,
        "promotion_readiness": {
            "inside_target_size_30_to_50": inside_target_size,
            "required_generator_roles_present": required_roles_present,
            "all_current_drum_roles_present": all_drum_roles_present,
            "gate_a_ok": gate_a_ok,
            "tracked_source_path_risks": tracked_path_risks,
            "owner_source_policy_required": owner_source_policy_required,
            "owner_gate_c_required": owner_gate_c_required,
            "staged_runtime_safe": inside_target_size and required_roles_present and all_drum_roles_present and gate_a_ok,
            "repo_promotion_safe_now": repo_promotion_safe_now,
        },
        "owner_decisions_needed": [
            "Decide whether these local MIDI-pack-derived recipes may remain local-runtime-only, be cited as private evidence, or be promoted into a tracked service/recipes/library set.",
            "Score the blind Gate C pack before opening answer_key.json; use that verdict before publishing or broadening this corpus.",
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a safe promotion packet for a local MIDI ingredient corpus")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="midi ingredient run directory")
    parser.add_argument("--gate-audit", default="", help="optional gate-a-midi-audit.json path")
    parser.add_argument("--out", default="", help="optional JSON output path")
    args = parser.parse_args(argv)

    packet = build_packet(
        Path(args.root),
        audit_path=Path(args.gate_audit) if args.gate_audit else None,
    )
    payload = json.dumps(packet, indent=2, sort_keys=True) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    readiness = packet["promotion_readiness"]
    return 0 if readiness["staged_runtime_safe"] and not readiness["tracked_source_path_risks"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
