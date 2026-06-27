"""The conductor. Drives a video through skeleton → (extract) → match → compile, checkpointing
the Recipe after every stage (resumable). Stages are injected (real ones wired in cli.py;
fakes in tests), so this module stays import-light and fully testable. Gates on a compile-time
completeness proxy: below the policy floor → status 'needs_review' (no confident-but-wrong).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from ..recipe import Recipe, from_json, to_json
from .decisions import label_element, name_sections
from .policy import Policy

DRUM_ROLES = {"kick", "snare", "hat", "clap", "perc", "808"}
STAGES = ("skeleton", "extract", "match", "compile")


class Stage(str, Enum):
    skeleton = "skeleton"
    extract = "extract"
    match = "match"
    compile = "compile"


@dataclass
class RunResult:
    recipe: Recipe
    commands: list = field(default_factory=list)
    unresolved: list = field(default_factory=list)
    status: str = "torn_down"        # torn_down | needs_review | failed
    stages_done: list = field(default_factory=list)
    completeness: float = 0.0
    error: Optional[str] = None


def _has_drum_elements(rec: Recipe) -> bool:
    return any(e.role.value in DRUM_ROLES for e in rec.elements)


def _completeness(rec: Recipe) -> float:
    """Compile-time proxy (NOT rendered similarity — that's §9-execute QA): how much of the
    recipe is fillable. meta presence + per-element resolved content."""
    filled = total = 0
    for mf in (rec.meta.tempo_bpm, rec.meta.key, rec.meta.daw):
        total += 1
        filled += 1 if mf.value not in (None, "") else 0
    for el in rec.elements:
        total += 1
        resolved = (el.sample_match.status == "matched"
                    or el.synth_patch.status in ("params_visible", "matched", "substituted")
                    or el.midi.status in ("extracted", "partial"))
        filled += 1 if resolved else 0
    return round(filled / total, 3) if total else 0.0


class Orchestrator:
    def __init__(self, *, policy: Optional[Policy] = None, checkpoint_dir=None,
                 skeleton_fn: Callable, match_fn: Callable, compile_fn: Callable,
                 extract_fn: Optional[Callable] = None) -> None:
        self.policy = policy or Policy()
        self.cp = Path(checkpoint_dir) if checkpoint_dir else None
        self._skeleton = skeleton_fn          # (video_ref) -> Recipe
        self._extract = extract_fn            # (recipe, video_ref) -> None  (adds drum elements); optional
        self._match = match_fn                # (recipe, element_id) -> None  (§1 match_into)
        self._compile = compile_fn            # (recipe) -> CompileResult-like (.commands, .unresolved)

    # ── checkpointing ───────────────────────────────────────────────────────
    def _paths(self, video_ref: str):
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", video_ref)[-80:]
        return self.cp / f"{safe}.recipe.json", self.cp / f"{safe}.stages.json"

    def _save(self, video_ref: str, rec: Recipe, done: list) -> None:
        if not self.cp:
            return
        self.cp.mkdir(parents=True, exist_ok=True)
        rp, sp = self._paths(video_ref)
        rp.write_text(to_json(rec))
        sp.write_text(json.dumps({"stages_done": done}))

    def _load(self, video_ref: str):
        if not self.cp:
            return None, []
        rp, sp = self._paths(video_ref)
        if rp.exists() and sp.exists():
            return from_json(rp.read_text()), json.loads(sp.read_text()).get("stages_done", [])
        return None, []

    # ── the staged run ──────────────────────────────────────────────────────
    def teardown(self, video_ref: str, resume: bool = True) -> RunResult:
        rec: Optional[Recipe] = None
        try:
            rec, done = self._load(video_ref) if resume else (None, [])

            if rec is None or "skeleton" not in done:
                rec = self._skeleton(video_ref)
                # heuristic section naming over generic "section N"
                names = name_sections(len(rec.arrangement.sections))
                for s, nm in zip(rec.arrangement.sections, names):
                    if s.name.startswith("section"):
                        s.name = nm
                done = ["skeleton"]
                self._save(video_ref, rec, done)

            if "extract" not in done:
                if self.policy.extract_when_no_drums and self._extract and not _has_drum_elements(rec):
                    self._extract(rec, video_ref)
                done.append("extract")
                self._save(video_ref, rec, done)

            if "match" not in done:
                for el in rec.elements:
                    if el.audio_ref and el.role.value in DRUM_ROLES:
                        self._match(rec, el.element_id)
                for el in rec.elements:
                    if not el.label:
                        el.label = label_element(el)
                done.append("match")
                self._save(video_ref, rec, done)

            compiled = self._compile(rec)
            if "compile" not in done:
                done.append("compile")
                self._save(video_ref, rec, done)

            comp = _completeness(rec)
            status = "torn_down" if comp >= self.policy.review_floor else "needs_review"
            return RunResult(recipe=rec, commands=list(getattr(compiled, "commands", [])),
                             unresolved=list(getattr(compiled, "unresolved", [])),
                             status=status, stages_done=done, completeness=comp)
        except Exception as e:  # a stage failed → honest failed status, never a crash to the caller
            return RunResult(recipe=rec if rec is not None else Recipe(),
                             status="failed", error=f"{type(e).__name__}: {e}")
