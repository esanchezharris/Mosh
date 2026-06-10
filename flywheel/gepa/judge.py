"""L4 — the LLM judge (phase0 §8). Rubric versioned in-repo; provider via the
service's llm adapter (gemini real / mock deterministic). The mock judge is a
structural heuristic so loop machinery is testable with zero spend — it is
NOT a quality signal and says so in its critique.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "service"))
from agent import llm  # noqa: E402

RUBRIC = (Path(__file__).parent / "rubrics/v1.md").read_text()


def judge(provider: str, instruction: str, ops: list, exec_counts: dict) -> dict:
    if provider == "mock":
        return _mock_judge(instruction, ops, exec_counts)
    user = (f"Instruction: {instruction}\n\nOp program ({len(ops)} ops):\n"
            + json.dumps(ops, indent=1)[:6000]
            + f"\n\nExecution counts: {json.dumps(exec_counts)}")
    try:
        raw = llm.complete(provider, RUBRIC, user, temperature=0.0)
        doc = json.loads(raw.strip().strip("`").lstrip("json"))
        doc["rubric_version"] = "v1"
        return doc
    except (llm.ProviderError, json.JSONDecodeError, KeyError) as e:
        return {"mean": 0.0, "critique": f"judge unavailable: {e}", "rubric_version": "v1"}


def _mock_judge(instruction: str, ops: list, exec_counts: dict) -> dict:
    """Deterministic structural stand-in: rewards executed ops + instruction
    keyword coverage. Calibrated to pass plausible programs (~4.x) and fail
    empty/broken ones — loop plumbing only, not musical judgment."""
    kinds = [op.get("kind", "") for op in ops]
    score = 3.0
    if exec_counts.get("failed", 1) == 0:
        score += 1.0
    if exec_counts.get("executed", 0) >= 3:
        score += 0.5
    words = instruction.lower()
    if "bpm" in words or any(t.isdigit() for t in words.split()):
        score += 0.25 if "project.set_tempo" in kinds else -0.5
    if "drum" in words or "kick" in words or "808" in words:
        score += 0.25 if "notes.add" in kinds else -0.5
    score = max(1.0, min(5.0, score))
    return {"groove_timing": round(score), "sound_selection": round(score),
            "arrangement_sanity": round(score), "instruction_adherence": round(score),
            "mean": round(score, 2),
            "critique": "MOCK judge: structural heuristic only (executed ops + keyword coverage), not musical judgment.",
            "rubric_version": "v1"}
