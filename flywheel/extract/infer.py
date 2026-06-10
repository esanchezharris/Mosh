"""Per-step op inference (phase0 §7.3): step narration (+ running session
summary) → MoshIR ops, via the same provider adapter + program assets as
Monster. Structured output validated against the schema; invalid → one repair
retry → else the step is marked `unextracted` (the trajectory can still be
accepted with gaps; gaps are recorded).

The extractor IS an agent program (the user's "agentic tutorial automation"):
same cheatsheet, same reflection memory, exemplars matched by genre/step —
GEPA can optimize this program exactly like Monster's.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "service"))
sys.path.insert(0, str(REPO_ROOT / "moshir"))

import validate as moshir_validate  # noqa: E402
from agent import llm, propose as agent_program  # noqa: E402

EXTRACT_SYSTEM_SUFFIX = """

# Extraction mode
You are transcribing a TUTORIAL STEP into ops, not improvising. Express what
the narrator DID — their tempo, their pattern shape, their device moves — at
tutorial-step granularity. If the narration names something the vocabulary
cannot express, do the expressible part; the gap ledger records the rest."""


def infer_step(step: dict, session_summary: str, provider: str,
               mock_ops: list | None = None) -> dict:
    """→ {ok, ops, rationale?} | {ok: False, unextracted: True, errors}."""
    if provider == "mock":
        # Deterministic fixture path: the fixture supplies per-step ops so the
        # pipeline is testable end-to-end with zero spend and zero variance.
        if mock_ops is not None:
            errors = [e for op in mock_ops for e in moshir_validate.validate_op(op)]
            return {"ok": not errors, "ops": mock_ops, "errors": errors,
                    "rationale": "fixture ops"}
        return {"ok": False, "unextracted": True,
                "errors": ["mock provider needs fixture ops for this step"]}

    program = agent_program.load_program()
    system = (program["system"] + EXTRACT_SYSTEM_SUFFIX
              + "\n\n# Cheatsheet\n" + program["cheatsheet"]
              + "\n\n# Lessons\n" + program["reflections"])
    parts = []
    for ex in agent_program.select_exemplars(program, step["narration"]):
        parts.append("Example instruction: " + ex["instruction"])
        parts.append("Example response: " + json.dumps(ex["response"]))
    if session_summary:
        parts.append("Session so far: " + session_summary)
    parts.append(f"Step narration ({step['narration_ts'][0]}s–{step['narration_ts'][1]}s): "
                 + step["narration"])
    parts.append('Reply with ONLY the JSON object: {"rationale": ..., "ops": [...]}.')

    raw = llm.complete(provider, system, "\n\n".join(parts))
    doc, errors = _parse(raw)
    if doc is None:
        parts.append("Your previous reply was INVALID:\n" + raw[:1500])
        parts.append("Validation errors:\n- " + "\n- ".join(errors[:8]))
        parts.append("Reply again with ONLY the corrected JSON object.")
        raw = llm.complete(provider, system, "\n\n".join(parts), temperature=0.0)
        doc, errors = _parse(raw)
    if doc is None:
        return {"ok": False, "unextracted": True, "errors": errors[:8]}
    return {"ok": True, "ops": doc["ops"], "rationale": doc.get("rationale", "")}


def _parse(raw: str):
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        text = text[4:] if text.startswith("json") else text
    try:
        doc = json.loads(text)
    except json.JSONDecodeError as e:
        return None, [f"not valid JSON: {e}"]
    ops = doc.get("ops")
    if not isinstance(ops, list) or not ops:
        return None, ["no non-empty 'ops' array"]
    errors = []
    for i, op in enumerate(ops):
        errors += [f"ops[{i}]: {m}" for m in moshir_validate.validate_op(op)]
    return (doc, []) if not errors else (None, errors)
