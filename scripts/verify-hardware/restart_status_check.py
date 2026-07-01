#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import gate_c_pack_check


REPO = Path(__file__).resolve().parents[2]
DEFAULT_ROOT = REPO / ".cache" / "mosh-teardown" / "midi-ingredients" / "2026-07-01-r7-curated"
DEFAULT_GATE_C_PACK = Path("~/mosh-beats/r7-gate-c-blind").expanduser()
DEFAULT_STOP = REPO / "docs" / "auto-loop" / "STOP"
REQUIRED_SCENARIOS = ("success", "missing-library-failure", "partial-apply-rollback")
REQUIRED_GATE_A_REQUIREMENTS = (
    "source_midi_note_fidelity",
    "minimum_corpus_size",
    "required_generator_roles",
    "all_current_drum_roles_covered",
    "generated_renders_non_silent",
    "melodic_808_sampler",
    "cross_source_recombination",
    "render_failures_absent",
)
REQUIRED_GENERATOR_ROLES = ("808", "kick", "hat", "pad")


def _display_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return str(resolved.relative_to(REPO))
    except ValueError:
        home = Path.home()
        try:
            return "~/" + str(resolved.relative_to(home))
        except ValueError:
            return str(path)


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if text:
            rows.append(json.loads(text))
    return rows


def _count_jsonl(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


def _gate_a_status(root: Path) -> tuple[dict[str, Any], list[str]]:
    path = root / "gate-a-midi-audit.json"
    if not path.is_file():
        return {"path": _display_path(path), "available": False}, [f"missing Gate A audit: {_display_path(path)}"]
    audit = _load_json(path)
    corpus_gate = audit.get("corpus_gate") or {}
    requirements = {
        str(item.get("name")): bool(item.get("ok"))
        for item in audit.get("requirements", [])
    }
    roles = corpus_gate.get("roles") or {}
    failures: list[str] = []
    if not bool(audit.get("ok")):
        failures.append("Gate A audit ok=false")
    checked = int(corpus_gate.get("checked") or 0)
    if not (30 <= checked <= 50):
        failures.append(f"Gate A corpus checked {checked}, expected 30-50")
    missing_roles = [role for role in REQUIRED_GENERATOR_ROLES if int(roles.get(role, 0) or 0) <= 0]
    if missing_roles:
        failures.append(f"Gate A missing generator roles: {', '.join(missing_roles)}")
    failed_reqs = [name for name in REQUIRED_GATE_A_REQUIREMENTS if requirements.get(name) is not True]
    if failed_reqs:
        failures.append(f"Gate A requirements not proven: {', '.join(failed_reqs)}")
    return (
        {
            "path": _display_path(path),
            "available": True,
            "ok": not failures,
            "checked": checked,
            "roles": roles,
            "requirements": {name: requirements.get(name) is True for name in REQUIRED_GATE_A_REQUIREMENTS},
        },
        failures,
    )


def _promotion_status(root: Path) -> tuple[dict[str, Any], list[str], list[str]]:
    path = root / "promotion-packet.json"
    if not path.is_file():
        return {"path": _display_path(path), "available": False}, [f"missing promotion packet: {_display_path(path)}"], []
    packet = _load_json(path)
    readiness = packet.get("promotion_readiness") or {}
    safe_report = packet.get("safe_report") or {}
    failures: list[str] = []
    owner_blockers: list[str] = []
    if readiness.get("staged_runtime_safe") is not True:
        failures.append("promotion packet staged_runtime_safe is not true")
    if int(readiness.get("tracked_source_path_risks") or 0) != 0:
        failures.append("promotion packet reports tracked source path risks")
    if readiness.get("tracked_research_promotion_path_safe") is False:
        failures.append("promotion packet reports unsafe tracked research recipe markers")
    if safe_report.get("raw_media_included") is not False or safe_report.get("raw_source_paths_included") is not False:
        failures.append("promotion packet is not source-path/media safe")
    if readiness.get("owner_source_policy_required") is True:
        owner_blockers.append("source_policy")
    return (
        {
            "path": _display_path(path),
            "available": True,
            "stagedRuntimeSafe": readiness.get("staged_runtime_safe") is True,
            "repoPromotionSafeNow": readiness.get("repo_promotion_safe_now") is True,
            "gateCOk": readiness.get("gate_c_ok") is True,
            "trackedResearchPromotionPresent": readiness.get("tracked_research_promotion_present") is True,
            "trackedResearchPromotionPathSafe": readiness.get("tracked_research_promotion_path_safe") is True,
            "trackedSourcePathRisks": int(readiness.get("tracked_source_path_risks") or 0),
            "ownerSourcePolicyRequired": readiness.get("owner_source_policy_required") is True,
            "ownerGateCRequired": readiness.get("owner_gate_c_required") is True,
            "safeReport": {
                "rawMediaIncluded": safe_report.get("raw_media_included") is True,
                "rawSourcePathsIncluded": safe_report.get("raw_source_paths_included") is True,
                "sourcePathClassesOnly": safe_report.get("source_path_classes_only") is True,
            },
        },
        failures,
        owner_blockers,
    )


def _generate_proof_status(root: Path) -> tuple[dict[str, Any], list[str]]:
    path = root / "default-runtime-generate-proof.jsonl"
    if not path.is_file():
        return {"path": _display_path(path), "available": False}, [f"missing installed generate proof: {_display_path(path)}"]
    rows = _load_jsonl(path)
    scenarios = {str(row.get("scenario")) for row in rows if row.get("scenario")}
    failures: list[str] = []
    missing = [scenario for scenario in REQUIRED_SCENARIOS if scenario not in scenarios]
    if missing:
        failures.append(f"generate proof missing scenarios: {', '.join(missing)}")
    success = next(
        (row for row in rows if row.get("scenario") == "success" and row.get("command") == "generate_beat_recipe"),
        {},
    )
    snapshot = next((row for row in rows if row.get("scenario") == "success" and row.get("command") == "__snapshot"), {})
    if success:
        if success.get("ok") is not True:
            failures.append("generate proof success scenario ok=false")
        if int(success.get("appliedCount") or -1) != int(success.get("commandCount") or -2):
            failures.append("generate proof did not apply every generated command")
        if success.get("unresolved") != []:
            failures.append("generate proof has unresolved refs")
        if success.get("usedExplicitRuntimeArgs") is not False:
            failures.append("generate proof did not prove bundled/default runtime")
    if snapshot:
        if int(snapshot.get("midiTrackCount") or 0) <= 0 or int(snapshot.get("noteCount") or 0) <= 0:
            failures.append("generate proof snapshot has no MIDI tracks or notes")
    else:
        failures.append("generate proof missing success snapshot")

    missing_library = next((row for row in rows if row.get("scenario") == "missing-library-failure"), {})
    if missing_library:
        if missing_library.get("ok") is not True or missing_library.get("noSideEffects") is not True:
            failures.append("missing-library failure proof did not preserve side effects")
        if missing_library.get("errorKind") != "recipe-library-missing":
            failures.append("missing-library failure proof has unexpected error kind")

    rollback = next((row for row in rows if row.get("scenario") == "partial-apply-rollback"), {})
    if rollback:
        if rollback.get("ok") is not True or rollback.get("noSideEffects") is not True:
            failures.append("partial-apply rollback proof did not preserve side effects")
        if rollback.get("errorKind") != "assign-sample-file-missing":
            failures.append("partial-apply rollback proof has unexpected error kind")

    return (
        {
            "path": _display_path(path),
            "available": True,
            "ok": not failures,
            "scenarios": sorted(scenarios),
            "appliedCount": int(success.get("appliedCount") or 0),
            "commandCount": int(success.get("commandCount") or 0),
            "midiTrackCount": int(snapshot.get("midiTrackCount") or 0),
            "noteCount": int(snapshot.get("noteCount") or 0),
            "defaultRuntimeProven": success.get("usedExplicitRuntimeArgs") is False,
        },
        failures,
    )


def _scout_status(root: Path) -> tuple[dict[str, Any], list[str]]:
    rescore = root / "rescore-catalog.json"
    midi_first = root / "teardown_jobs-midi-first.jsonl"
    midi_ingredients = root / "teardown_jobs-midi-ingredients.jsonl"
    catalog = root / "catalog-midi-first.sqlite"
    failures: list[str] = []
    if not rescore.is_file():
        failures.append(f"missing rescore summary: {_display_path(rescore)}")
        summary: dict[str, Any] = {}
    else:
        summary = (_load_json(rescore).get("summary") or {})
    if not catalog.is_file():
        failures.append(f"missing rescored catalog: {_display_path(catalog)}")
    ingredient_jobs = _count_jsonl(midi_ingredients)
    first_jobs = _count_jsonl(midi_first)
    if ingredient_jobs <= 0:
        failures.append("no evidence-filtered MIDI ingredient scout jobs exported")
    return (
        {
            "rescoreSummaryPath": _display_path(rescore),
            "catalogPath": _display_path(catalog),
            "catalogPresent": catalog.is_file(),
            "totalCandidates": int(summary.get("total") or 0),
            "byStatus": summary.get("by_status") or {},
            "midiFirstJobs": first_jobs,
            "midiIngredientJobs": ingredient_jobs,
        },
        failures,
    )


def _gate_c_status(pack: Path) -> tuple[dict[str, Any], list[str], list[str]]:
    status = gate_c_pack_check.build_status(pack, reveal=False)
    failures = list(status.get("structuralErrors") or [])
    wavs = status.get("wavFiles") or {}
    scorecard = status.get("scorecard") or {}
    if int(wavs.get("checked") or 0) <= 0:
        failures.append("Gate C pack has no checked WAVs")
    if len(wavs.get("bad") or []) > 0:
        failures.append("Gate C pack has invalid WAVs")
    owner_blockers: list[str] = []
    if scorecard.get("complete") is not True:
        owner_blockers.append("gate_c_scorecard")
    return (
        {
            "pack": status.get("pack"),
            "readmePresent": status.get("readmePresent") is True,
            "answerKeyPresent": status.get("answerKeyPresent") is True,
            "answerKeyRead": status.get("answerKeyRead") is True,
            "blindPreserved": status.get("blindPreserved") is True,
            "wavFiles": {
                "checked": int(wavs.get("checked") or 0),
                "ok": int(wavs.get("ok") or 0),
                "badCount": len(wavs.get("bad") or []),
            },
            "scorecard": {
                "rows": int(scorecard.get("rows") or 0),
                "expectedRows": int(scorecard.get("expectedRows") or 0),
                "filledRows": int(scorecard.get("filledRows") or 0),
                "complete": scorecard.get("complete") is True,
                "invalidScoreCount": len(scorecard.get("invalidScores") or []),
                "groupErrorCount": len(scorecard.get("groupErrors") or []),
            },
        },
        failures,
        owner_blockers,
    )


def build_status(root: Path, *, gate_c_pack: Path, stop_path: Path = DEFAULT_STOP) -> dict[str, Any]:
    root = root.expanduser()
    repo_failures: list[str] = []
    owner_blockers: list[str] = []

    stop_present = stop_path.is_file()
    if not stop_present:
        repo_failures.append(f"STOP missing: {_display_path(stop_path)}")

    gate_a, failures = _gate_a_status(root)
    repo_failures.extend(failures)
    promotion, failures, blockers = _promotion_status(root)
    repo_failures.extend(failures)
    owner_blockers.extend(blockers)
    generate_proof, failures = _generate_proof_status(root)
    repo_failures.extend(failures)
    scout, failures = _scout_status(root)
    repo_failures.extend(failures)
    gate_c, failures, blockers = _gate_c_status(gate_c_pack)
    repo_failures.extend(failures)
    owner_blockers.extend(blockers)

    owner_blockers = sorted(set(owner_blockers))
    repo_failures = sorted(set(repo_failures))
    complete = not repo_failures and not owner_blockers
    repo_ready_for_owner = not repo_failures and bool(owner_blockers)
    return {
        "schemaVersion": 1,
        "root": _display_path(root),
        "stop": {"path": _display_path(stop_path), "present": stop_present},
        "gateA": gate_a,
        "promotion": promotion,
        "installedGenerateProof": generate_proof,
        "scoutRescore": scout,
        "gateC": gate_c,
        "repoFailures": repo_failures,
        "ownerBlockers": owner_blockers,
        "repoReadyForOwnerDecision": repo_ready_for_owner,
        "complete": complete,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Summarize safe real-recipes restart completion evidence")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="r7 curated MIDI ingredient root")
    parser.add_argument("--gate-c-pack", default=str(DEFAULT_GATE_C_PACK), help="Gate C blind pack directory")
    parser.add_argument("--stop", default=str(DEFAULT_STOP), help="STOP sentinel path")
    parser.add_argument("--allow-owner-blockers", action="store_true", help="exit 0 when only owner decisions remain")
    parser.add_argument("--out", default="", help="optional JSON output path")
    args = parser.parse_args(argv)

    status = build_status(
        Path(args.root),
        gate_c_pack=Path(args.gate_c_pack),
        stop_path=Path(args.stop),
    )
    payload = json.dumps(status, indent=2, sort_keys=True) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    if status["complete"]:
        return 0
    if args.allow_owner_blockers and status["repoReadyForOwnerDecision"]:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
