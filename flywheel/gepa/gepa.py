#!/usr/bin/env python3
"""GEPA loop (phase0 §10): reflective prompt evolution over the Monster
program. Typed textual feedback (lowering errors, expectation misses, judge
critiques) feeds a reflection model that mutates the program's reflection
memory; candidates compete on a per-task Pareto pool.

  python3 -m flywheel.gepa.gepa [--provider mock|gemini]
      [--reflect-provider mock|claude|gemini] [--generations 2]
      [--candidates 2] [--tasks 4] [--out runs/gepa]

Budget reality (spec §10): the real campaign is ~10 rollouts x ~15 iterations
x 24 tasks with Gemini Flash ($50-200 total) — fired explicitly by the owner
with GEMINI_API_KEY set. Mock runs prove the loop converges mechanically.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "service"))
from agent import llm  # noqa: E402
from flywheel.gepa import rollout  # noqa: E402
from flywheel.gepa.eval import TASKS  # noqa: E402

PROGRAM_V0 = Path(__file__).parent / "program/v0"

REFLECT_PROMPT = """You are the reflection step of a GEPA loop optimizing a \
music-producer agent's prompt program. Below are this candidate's per-task \
failures and critiques. Write 1-3 NEW one-line lessons (imperative, concrete, \
non-duplicative) to append to the program's reflection memory. Reply with \
ONLY a JSON array of strings."""


def make_candidate(base: Path, out_dir: Path, n: int, lessons: list[str]) -> Path:
    cand = out_dir / f"candidate-{n}"
    if cand.exists():
        shutil.rmtree(cand)
    shutil.copytree(base, cand)
    if lessons:
        with (cand / "reflections.md").open("a") as f:
            for lesson in lessons:
                f.write(f"- {lesson}\n")
    manifest = json.loads((cand / "program.json").read_text())
    manifest["version"] = f"{manifest['version']}+cand{n}"
    (cand / "program.json").write_text(json.dumps(manifest, indent=2))
    return cand


def reflect(provider: str, feedback: list[str]) -> list[str]:
    if not feedback:
        return []
    if provider == "mock":
        # Deterministic: one lesson distilled from the most common failure tag.
        first = feedback[0][:120].replace('"', "'")
        return [f"address recurring issue: {first}"]
    try:
        raw = llm.complete(provider, REFLECT_PROMPT,
                           "\n".join(feedback[:40]), temperature=0.4)
        lessons = json.loads(raw.strip().strip("`").lstrip("json"))
        return [str(x) for x in lessons][:3] if isinstance(lessons, list) else []
    except (llm.ProviderError, json.JSONDecodeError):
        return []


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", default="mock")
    ap.add_argument("--reflect-provider", default=None)
    ap.add_argument("--generations", type=int, default=2)
    ap.add_argument("--candidates", type=int, default=2)
    ap.add_argument("--tasks", type=int, default=4)
    ap.add_argument("--out", type=Path, default=Path("runs/gepa"))
    ap.add_argument("--db", type=Path)
    a = ap.parse_args()
    reflect_provider = a.reflect_provider or a.provider
    tasks = TASKS[: a.tasks]
    a.out.mkdir(parents=True, exist_ok=True)

    # Pareto pool: candidate → per-task scores. A candidate survives if it is
    # not dominated (another candidate >= on every task and > on one).
    pool: list[dict] = []
    pending_lessons: list[list[str]] = [[] for _ in range(a.candidates)]
    report = a.out / "gepa-report.jsonl"
    rollouts = 0
    with report.open("w") as rep:
        for gen in range(a.generations):
            for ci in range(a.candidates):
                cand_dir = make_candidate(PROGRAM_V0, a.out, gen * a.candidates + ci,
                                          pending_lessons[ci])
                scores, feedback = {}, []
                for t in tasks:
                    r = rollout.run_rollout(t, a.provider, program_dir=cand_dir,
                                            db_path=a.db)
                    rollouts += 1
                    scores[t["id"]] = r["score"]
                    feedback += [f for f in r["feedback"] if not r["ok"]]
                entry = {"gen": gen, "candidate": cand_dir.name,
                         "scores": scores,
                         "mean": round(sum(scores.values()) / len(scores), 4),
                         "lessons_applied": pending_lessons[ci]}
                pool.append(entry)
                rep.write(json.dumps(entry) + "\n")
                print(f"  gen{gen} {cand_dir.name}: mean={entry['mean']}")
                pending_lessons[ci] = reflect(reflect_provider, feedback)

        # Pareto filter + winner.
        def dominated(e: dict) -> bool:
            return any(o is not e
                       and all(o["scores"][k] >= e["scores"][k] for k in e["scores"])
                       and any(o["scores"][k] > e["scores"][k] for k in e["scores"])
                       for o in pool)
        front = [e for e in pool if not dominated(e)]
        winner = max(front, key=lambda e: e["mean"])
        summary = {"summary": True, "rollouts": rollouts,
                   "pool": len(pool), "pareto_front": len(front),
                   "winner": winner["candidate"], "winner_mean": winner["mean"],
                   "ts": int(time.time())}
        rep.write(json.dumps(summary) + "\n")
    print("winner:", winner["candidate"], "mean", winner["mean"],
          f"({rollouts} rollouts, pareto front {len(front)}/{len(pool)})")


if __name__ == "__main__":
    main()
