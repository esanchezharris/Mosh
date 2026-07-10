#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import gate_c_pack_check

DEFAULT_ROOT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated"
DEFAULT_TRACKED_LIBRARY = REPO / "service" / "recipes" / "library"
DEFAULT_GATE_C_PACK = Path("~/mosh-beats/r7-gate-c-blind").expanduser()
DEFAULT_OWNER_DECISION = REPO / "docs" / "research-policy" / "2026-07-01-r7-research-promotion.md"
REQUIRED_GENERATOR_ROLES = ("808", "kick", "hat", "pad")
DRUM_ROLES = ("kick", "snare", "hat", "clap", "perc")
SOURCE_POLICY_CHOICES = ("owner-required", "research-tracked")
TRACKED_LIBRARY_FORBIDDEN_MARKERS = (
    ".mid",
    ".midi",
    ".wav",
    "palette",
    "manifest",
    "answer_key",
)


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


def _tracked_research_status(root: Path, tracked_library: Path) -> dict[str, Any]:
    corpus_library = root / "library"
    expected = sorted(corpus_library.glob("*.json"))
    tracked_library = tracked_library.resolve()
    missing = [path.name for path in expected if not (tracked_library / path.name).is_file()]
    marker_hits: list[dict[str, str]] = []
    forbidden_markers = list(TRACKED_LIBRARY_FORBIDDEN_MARKERS)
    forbidden_markers.append(str(Path.home()))
    forbidden_markers.append("/" + "Users/")
    for path in expected:
        tracked_path = tracked_library / path.name
        if not tracked_path.is_file():
            continue
        text = tracked_path.read_text(encoding="utf-8")
        for marker in forbidden_markers:
            if marker in text:
                marker_hits.append({"file": path.name, "marker": marker})
                break
    return {
        "tracked_library": _display_path(tracked_library),
        "expected_count": len(expected),
        "promoted_count": len(expected) - len(missing),
        "missing_count": len(missing),
        "missing_sample": missing[:10],
        "present": bool(expected) and not missing,
        "tracked_files_path_safe": not marker_hits,
        "forbidden_marker_hits": marker_hits[:25],
    }


def _gate_c_status(gate_c_pack: Path) -> dict[str, Any]:
    status = gate_c_pack_check.build_status(gate_c_pack, reveal=False)
    scorecard = status.get("scorecard") or {}
    wavs = status.get("wavFiles") or {}
    structural_errors = status.get("structuralErrors") or []
    return {
        "pack": status.get("pack"),
        "blind_preserved": status.get("blindPreserved") is True,
        "answerKeyRead": status.get("answerKeyRead") is True,
        "scorecard_complete": scorecard.get("complete") is True,
        "scorecard_rows": int(scorecard.get("rows") or 0),
        "scorecard_filled_rows": int(scorecard.get("filledRows") or 0),
        "scorecard_expected_rows": int(scorecard.get("expectedRows") or 0),
        "invalid_score_count": len(scorecard.get("invalidScores") or []),
        "group_error_count": len(scorecard.get("groupErrors") or []),
        "wav_checked": int(wavs.get("checked") or 0),
        "wav_bad_count": len(wavs.get("bad") or []),
        "structural_error_count": len(structural_errors),
    }


def _owner_decision_status(path: Path) -> dict[str, Any]:
    resolved = path.expanduser().resolve()
    exists = resolved.is_file()
    inside_repo = False
    in_cache = False
    try:
        rel = resolved.relative_to(REPO)
        inside_repo = True
        in_cache = bool(rel.parts and rel.parts[0] == ".cache")
        display = str(rel)
    except ValueError:
        display = _display_path(resolved)
    return {
        "path": display,
        "present": exists,
        "inside_repo": inside_repo,
        "outside_cache": not in_cache,
        "durable": exists and inside_repo and not in_cache,
    }


def _owner_source_policy_required(source_policy: str, tracked_research_ready: bool, owner_decision: dict[str, Any]) -> bool:
    return not (
        source_policy == "research-tracked"
        and tracked_research_ready
        and owner_decision.get("durable") is True
    )


def build_packet(
    root: Path,
    *,
    audit_path: Path | None = None,
    source_policy: str = "owner-required",
    tracked_library: Path = DEFAULT_TRACKED_LIBRARY,
    gate_c_pack: Path = DEFAULT_GATE_C_PACK,
    owner_decision: Path = DEFAULT_OWNER_DECISION,
) -> dict[str, Any]:
    root = root.resolve()
    corpus = _read_corpus(root)
    gate_a = _gate_a_status(root, audit_path)
    tracked_research = _tracked_research_status(root, tracked_library)
    gate_c = _gate_c_status(gate_c_pack)
    owner_decision_status = _owner_decision_status(owner_decision)
    counts = corpus["counts_by_role"]
    required_roles_present = all(int(counts.get(role, 0)) > 0 for role in REQUIRED_GENERATOR_ROLES)
    all_drum_roles_present = all(int(counts.get(role, 0)) > 0 for role in DRUM_ROLES)
    inside_target_size = 30 <= int(corpus["recipe_count"]) <= 50
    tracked_path_risks = int(corpus["source_path_classes"].get("repo-tracked-risk", 0))
    gate_a_ok = gate_a["ok"] is True
    research_policy_active = source_policy == "research-tracked"
    tracked_research_ready = (
        tracked_research["present"] is True
        and tracked_research["tracked_files_path_safe"] is True
    )
    gate_c_ok = (
        gate_c["blind_preserved"] is True
        and gate_c["answerKeyRead"] is False
        and gate_c["scorecard_complete"] is True
        and gate_c["invalid_score_count"] == 0
        and gate_c["group_error_count"] == 0
        and gate_c["wav_bad_count"] == 0
        and gate_c["structural_error_count"] == 0
    )
    owner_source_policy_required = _owner_source_policy_required(
        source_policy,
        tracked_research_ready,
        owner_decision_status,
    )
    owner_gate_c_required = not gate_c_ok
    repo_promotion_safe_now = (
        inside_target_size
        and required_roles_present
        and all_drum_roles_present
        and gate_a_ok
        and tracked_path_risks == 0
        and tracked_research_ready
        and gate_c_ok
        and not owner_source_policy_required
        and not owner_gate_c_required
    )
    owner_decisions_needed: list[str] = []
    if owner_source_policy_required:
        owner_decisions_needed.append(
            "Decide whether these local MIDI-pack-derived recipes may remain local-runtime-only, "
            "be cited as private evidence, or be promoted into a tracked service/recipes/library set."
        )
    if owner_gate_c_required:
        owner_decisions_needed.append(
            "Score the blind Gate C pack before opening answer_key.json; use that verdict before publishing or broadening this corpus."
        )

    return {
        "schema_version": 1,
        "root": _display_path(root),
        "research_policy": {
            "source_policy": source_policy,
            "research_only": True,
            "public_distribution_requires_separate_rights_decision": True,
            "owner_decision": owner_decision_status,
        },
        "safe_report": {
            "raw_source_paths_included": False,
            "raw_media_included": False,
            "source_path_classes_only": True,
        },
        "corpus": corpus,
        "gate_a": gate_a,
        "gate_c": gate_c,
        "tracked_research_promotion": tracked_research,
        "promotion_readiness": {
            "inside_target_size_30_to_50": inside_target_size,
            "required_generator_roles_present": required_roles_present,
            "all_current_drum_roles_present": all_drum_roles_present,
            "gate_a_ok": gate_a_ok,
            "gate_c_ok": gate_c_ok,
            "tracked_research_promotion_present": tracked_research["present"],
            "tracked_research_promotion_path_safe": tracked_research["tracked_files_path_safe"],
            "owner_source_policy_decision_present": owner_decision_status["durable"],
            "tracked_source_path_risks": tracked_path_risks,
            "owner_source_policy_required": owner_source_policy_required,
            "owner_gate_c_required": owner_gate_c_required,
            "staged_runtime_safe": inside_target_size and required_roles_present and all_drum_roles_present and gate_a_ok,
            "repo_promotion_safe_now": repo_promotion_safe_now,
        },
        "owner_decisions_needed": owner_decisions_needed,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a safe promotion packet for a local MIDI ingredient corpus")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="midi ingredient run directory")
    parser.add_argument("--gate-audit", default="", help="optional gate-a-midi-audit.json path")
    parser.add_argument("--source-policy", choices=SOURCE_POLICY_CHOICES, default="owner-required")
    parser.add_argument("--tracked-library", default=str(DEFAULT_TRACKED_LIBRARY), help="tracked recipe library path")
    parser.add_argument("--gate-c-pack", default=str(DEFAULT_GATE_C_PACK), help="Gate C blind pack directory")
    parser.add_argument("--owner-decision", default=str(DEFAULT_OWNER_DECISION), help="tracked owner-decision artifact path")
    parser.add_argument("--out", default="", help="optional JSON output path")
    args = parser.parse_args(argv)

    packet = build_packet(
        Path(args.root),
        audit_path=Path(args.gate_audit) if args.gate_audit else None,
        source_policy=args.source_policy,
        tracked_library=Path(args.tracked_library),
        gate_c_pack=Path(args.gate_c_pack),
        owner_decision=Path(args.owner_decision),
    )
    payload = json.dumps(packet, indent=2, sort_keys=True) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    readiness = packet["promotion_readiness"]
    if args.source_policy == "research-tracked":
        return 0 if readiness["repo_promotion_safe_now"] else 1
    return 0 if readiness["staged_runtime_safe"] and not readiness["tracked_source_path_risks"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
