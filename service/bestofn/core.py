"""Best-of-n scorer core (WP-11) — the "verifiable checks" half of the program's
shared scorer seam (MOSHI_TRAINING_PROGRAM_2026-07 §5 Stage-2 item 3), PURE and
deterministic: no network, no brain, filesystem touched only for path-existence
checks on candidate args.

Spec: docs/superpowers/specs/2026-07-04-bestofn-serving-skeleton.md. Design points
that came out of the pre-build panel and are load-bearing here:

- GROUNDING is the measured failure class (stale ids ×16) → an id-bearing arg that
  references an entity absent from the posted manifest hard-zeros the candidate —
  UNLESS an earlier command in the same candidate plausibly created an entity of
  that type, in which case the check is NEUTRAL (0.5 credit): the executor has no
  id-capture, so created ids are unverifiable, and hard-zeroing them would bias
  best-of-n against create-then-populate batches.
- FILE args in the curated catalog are all INPUT paths (the catalog deliberately
  excludes project IO) → a non-existent input path hard-zeros (the invented-file
  class). If an output-path command ever enters the catalog, add it to
  OUTPUT_PATH_ARGS so only its parent dir is required.
- One unknown/malformed command fails its checks WITHOUT hard-zeroing the batch —
  validity signal from the remaining commands still ranks.
- Ties are EXPECTED under verifiable-only scoring (validity, not taste): ranking
  records tieBreak + scoreMargin so archived "preferences" born from the
  fewer-commands tie-break are self-identifying and the DPO harvest can filter
  them. The taste separation arrives via the `ranker` seam (post-render audio —
  a labeled follow-up, never faked here).
"""
from __future__ import annotations

import json
import os
from typing import Callable, Dict, List, Optional, Tuple

# Id-bearing arg name → the entity type it must reference.
ID_ARGS: Dict[str, str] = {
    "trackId": "track",
    "clipId": "clip",
    "sectionId": "section",
    "annotationId": "annotation",
}

# Manifest key per entity type.
_MANIFEST_KEY = {"track": "trackIds", "clip": "clipIds",
                 "section": "sectionIds", "annotation": "annotationIds"}

# Commands that create an entity of a given type (so a LATER command's unknown id
# of that type is plausibly the new entity — neutral, not hallucinated).
CREATE_COMMANDS: Dict[str, str] = {
    "create_track": "track",
    "add_midi_clip": "clip",
    "add_test_tone_clip": "clip",
    "import_clip": "clip",
    "duplicate_clip": "clip",
    "split_clip": "clip",
    "sketch_beatbox": "clip",
    "create_section": "section",
    "create_annotation": "annotation",
}

# (command, arg) pairs whose value is a filesystem path. All current catalog path
# args are INPUTS (must exist). OUTPUT paths (parent dir must exist) is kept as an
# explicit, currently-empty table rather than a guess.
INPUT_PATH_ARGS = {("import_clip", "file"), ("sketch_beatbox", "file"), ("assign_sample", "file")}
OUTPUT_PATH_ARGS: set = set()

_TYPE_CHECK = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def _canonical(commands: List[dict]) -> str:
    return json.dumps(commands, sort_keys=True, separators=(",", ":"))


def dedupe_candidates(candidates: List[dict]) -> Tuple[List[dict], int]:
    """Drop candidates whose `commands` are canonically identical (first wins)."""
    seen: set = set()
    unique: List[dict] = []
    dups = 0
    for c in candidates:
        key = _canonical(c.get("commands") or [])
        if key in seen:
            dups += 1
            continue
        seen.add(key)
        unique.append(c)
    return unique, dups


def score_candidate(manifest: dict, catalog: List[dict], commands: List[dict]) -> dict:
    """Verifiable checks → {score: 0..1, reasons: [str]}. Hard zero on: empty/
    malformed shape, a hallucinated id (absent from manifest with no prior create
    of that type), or a non-existent input file path."""
    reasons: List[str] = []
    if not isinstance(commands, list) or not commands or not all(
            isinstance(c, dict) and isinstance(c.get("command"), str) and isinstance(c.get("args", {}), dict)
            for c in commands):
        return {"score": 0.0, "reasons": ["shape: empty or malformed commands array"]}

    specs = {c["command"]: c.get("args") or [] for c in catalog}
    passes = fails = neutrals = 0
    hard = False
    created: set = set()  # entity types created so far in THIS candidate

    for i, cmd in enumerate(commands):
        name = cmd["command"]
        args = cmd.get("args") or {}
        tag = f"cmd[{i}] {name}"

        spec = specs.get(name)
        if spec is None:
            fails += 1
            reasons.append(f"{tag} catalog: unknown command")
            continue
        passes += 1

        # Required args present + declared types match.
        argspec = {a["name"]: a for a in spec}
        bad = False
        for a in spec:
            if a.get("required") and a["name"] not in args:
                fails += 1
                reasons.append(f"{tag} required: missing arg '{a['name']}'")
                bad = True
                break
        if not bad:
            for k, v in args.items():
                a = argspec.get(k)
                if a is not None and not _TYPE_CHECK.get(a.get("type", "string"), lambda _: True)(v):
                    fails += 1
                    reasons.append(f"{tag} type: arg '{k}' should be {a.get('type')}")
                    bad = True
                    break
        if not bad:
            passes += 1

        # Grounding: id-bearing args must be in the manifest, or plausibly created
        # earlier in this candidate (neutral — unverifiable, not hallucinated).
        for k, v in args.items():
            etype = ID_ARGS.get(k)
            if etype is None or not isinstance(v, str):
                continue
            if v in (manifest.get(_MANIFEST_KEY[etype]) or []):
                passes += 1
            elif etype in created:
                neutrals += 1
                reasons.append(f"{tag} grounding: '{v}' unverifiable (created earlier in batch)")
            else:
                hard = True
                reasons.append(f"{tag} grounding: '{v}' is not a live {etype} id")

        # File paths: inputs must exist; outputs need only a parent dir.
        for k, v in args.items():
            if not isinstance(v, str):
                continue
            if (name, k) in INPUT_PATH_ARGS:
                if os.path.isfile(os.path.expanduser(v)):
                    passes += 1
                else:
                    hard = True
                    reasons.append(f"{tag} file: input path does not exist: {v}")
            elif (name, k) in OUTPUT_PATH_ARGS:
                if os.path.isdir(os.path.dirname(os.path.expanduser(v)) or "."):
                    passes += 1
                else:
                    fails += 1
                    reasons.append(f"{tag} file: output parent dir missing: {v}")

        if name in CREATE_COMMANDS:
            created.add(CREATE_COMMANDS[name])

    if hard:
        return {"score": 0.0, "reasons": reasons}
    total = passes + neutrals + fails
    score = (passes + 0.5 * neutrals) / total if total else 0.0
    return {"score": round(score, 6), "reasons": reasons}


def rank_candidates(scored: List[dict], ranker: Optional[Callable[[dict], float]] = None) -> dict:
    """Rank scored candidates → {order, chosenIndex, tieBreak, scoreMargin}.

    Validity is the HARD primary key: a verifiable score of 0 (hallucinated id /
    invented file / all-failed shape) always ranks below any positive score, so the
    optional `ranker` callable (the taste seam — higher is better) can never promote
    an invalid candidate over a valid one for ANY magnitude/sign it returns. WITHIN
    the valid set the ranker is summed at 1/10 weight to break ties and nudge
    near-ties (the audio-taste follow-up). Fallback tie-break: fewer commands, then
    stable input order."""
    def key(i: int) -> tuple:
        c = scored[i]
        r = float(ranker(c)) if ranker is not None else 0.0
        invalid = c["score"] <= 0.0                          # hard-zero ⇒ always last
        nudge = 0.0 if invalid else min(max(r, -1e6), 1e6) * 0.1
        return (invalid, -(c["score"] + nudge), len(c.get("commands") or []), i)

    order = sorted(range(len(scored)), key=key)
    top_score = scored[order[0]]["score"] if order else 0.0
    runner = scored[order[1]]["score"] if len(order) > 1 else None
    margin = (top_score - runner) if runner is not None else top_score
    tie = runner is not None and abs(top_score - runner) < 1e-9
    return {"order": order, "chosenIndex": order[0] if order else -1,
            "tieBreak": bool(tie), "scoreMargin": round(margin, 6)}
