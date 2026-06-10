"""Monster v0 proposal handler (phase0 §10): instruction → MoshIR ops.

Loads the version-pinned program (system prompt + cheatsheet + few-shot
exemplars + reflection memory), calls the provider, validates the returned
ops against moshir-0.1.schema.json, and on invalid output performs exactly
ONE repair retry with the validation errors as feedback (spec §7.3). Invalid
after repair → a structured failure with the errors (GEPA's textual food),
never a crash and never unvalidated ops.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "moshir"))
import validate as moshir_validate  # noqa: E402

from . import llm  # noqa: E402

DEFAULT_PROGRAM = REPO_ROOT / "flywheel/gepa/program/v0"


def load_program(program_dir: Path | None = None) -> dict:
    d = Path(os.environ.get("MOSH_AGENT_PROGRAM", program_dir or DEFAULT_PROGRAM))
    manifest = json.loads((d / "program.json").read_text())
    files = manifest["files"]
    exemplars = []
    for line in (d / files["exemplars"]).read_text().splitlines():
        if line.strip():
            exemplars.append(json.loads(line))
    return {
        "dir": d,
        "manifest": manifest,
        "system": (d / files["system"]).read_text(),
        "cheatsheet": (d / files["cheatsheet"]).read_text(),
        "reflections": (d / files["reflections"]).read_text(),
        "exemplars": exemplars,
    }


def select_exemplars(program: dict, instruction: str) -> list[dict]:
    """Naive relevance: keyword overlap on genre/step_type words. GEPA later
    owns this policy; few_shot_count caps it."""
    n = int(program["manifest"].get("few_shot_count", 4))
    words = set(instruction.lower().split())
    scored = sorted(
        program["exemplars"],
        key=lambda e: -len(words & set(
            (e.get("genre", "") + " " + e.get("step_type", "") + " "
             + e.get("instruction", "")).lower().split())))
    return scored[:n]


def build_prompt(program: dict, instruction: str, session_summary: str | None,
                 history: list | None, repair_errors: list[str] | None = None,
                 prior_raw: str | None = None) -> tuple[str, str]:
    system = (program["system"] + "\n\n# Cheatsheet\n" + program["cheatsheet"]
              + "\n\n# Lessons\n" + program["reflections"])
    parts = []
    for ex in select_exemplars(program, instruction):
        parts.append("Example instruction: " + ex["instruction"])
        parts.append("Example response: " + json.dumps(ex["response"]))
    if session_summary:
        parts.append("Current session: " + session_summary)
    for h in history or []:
        parts.append(f"{h.get('role', 'user')}: {h.get('text', '')}")
    parts.append("Instruction: " + instruction)
    if repair_errors is not None:
        parts.append("Your previous reply was INVALID:\n" + (prior_raw or "")[:2000])
        parts.append("Validation errors:\n- " + "\n- ".join(repair_errors[:10]))
        parts.append("Reply again with ONLY the corrected JSON object.")
    else:
        parts.append('Reply with ONLY the JSON object: {"rationale": ..., "ops": [...]}.')
    return system, "\n\n".join(parts)


def _parse(raw: str) -> tuple[dict | None, list[str]]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        text = text[4:] if text.startswith("json") else text
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        return None, [f"reply is not valid JSON: {e}"]
    ops = doc.get("ops")
    if not isinstance(ops, list) or not ops:
        return None, ["reply has no non-empty 'ops' array"]
    errors = []
    for i, op in enumerate(ops):
        for msg in moshir_validate.validate_op(op):
            errors.append(f"ops[{i}] ({op.get('kind') if isinstance(op, dict) else '?'}): {msg}")
    return (doc, []) if not errors else (None, errors)


def propose(payload: dict) -> dict:
    instruction = (payload.get("instruction") or "").strip()
    if not instruction:
        return {"ok": False, "error": "missing 'instruction'"}
    provider = payload.get("provider") or os.environ.get("MOSH_AGENT_PROVIDER", "gemini")
    program = load_program()

    system, user = build_prompt(program, instruction,
                                payload.get("session_summary"), payload.get("history"))
    attempts = []
    try:
        raw = llm.complete(provider, system, user)
    except llm.ProviderError as e:
        return {"ok": False, "error": str(e), "provider": provider}
    doc, errors = _parse(raw)

    if doc is None:
        attempts.append({"errors": errors})
        # Exactly ONE repair retry (spec §7.3) with the typed feedback.
        system, user = build_prompt(program, instruction,
                                    payload.get("session_summary"), payload.get("history"),
                                    repair_errors=errors, prior_raw=raw)
        try:
            # Repair runs at temperature 0: malformed-JSON failures are mostly
            # sampling noise in long arrays — determinism is the cure.
            raw = llm.complete(provider, system, user, temperature=0.0)
        except llm.ProviderError as e:
            return {"ok": False, "error": str(e), "provider": provider, "attempts": attempts}
        doc, errors = _parse(raw)

    if doc is None:
        return {"ok": False, "error": "invalid after repair retry",
                "validation_errors": errors[:10], "provider": provider,
                "program_version": program["manifest"]["version"]}
    return {"ok": True, "ops": doc["ops"], "rationale": doc.get("rationale", ""),
            "provider": provider, "model": program["manifest"].get("model"),
            "program_version": program["manifest"]["version"],
            "repaired": bool(attempts)}
