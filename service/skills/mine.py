#!/usr/bin/env python3
"""Mine v1 skills from the real demonstration corpus.

Pipeline (fully deterministic — no ML, no randomness):

  1. `load_corpus_rows`  — read the SFT jsonl files, extract (task, MoshOps
     command sequence) pairs. Skips rows with no assistant commands.
  2. `dedupe_rows`       — the corpus repeats some literal (task, commands)
     pairs across files (SFT weighting); collapse them, keeping every
     source row as provenance on the single resulting example.
  3. `struct_shape`      — run-length-compress each example's command-name
     sequence into (name, multiplicity, arg-key-signature) tuples. This is
     the PRIMARY clustering key: two examples land in the same bucket iff
     they call the same commands, in the same order, with the same argument
     *shape* — regardless of concrete values. "multiplicity" is "1" (the
     command appears exactly once) or "+" (repeated 2+ times), which lets
     e.g. `load_builtin` + `set_plugin_param`×1/×2/×3 (highpass/compress/
     brighten all use different param counts) generalize under one bucket
     shape while still being told apart from `load_builtin` alone.
  4. Within a bucket that contains a repeated run (only there — a command
     called exactly once per row is already fully disambiguated by its
     shape; splitting further would just fragment one skill by which verb-
     synonym a demo happened to use):
       a. `notes_traceable` presplit — for add_note/set_note buckets whose
          repeated run sets `pitch`, separate rows whose pitches are
          exactly reconstructible from explicit note names in the task text
          ("A1, C#2, E2") from rows that are not (a generated pattern, or a
          transform of notes that already exist in the clip).
       b. `keyword_split` — a greedy TF-IDF anchor split: repeatedly pick
          the corpus-rare token that covers the most still-unassigned rows,
          bucket every row containing it, repeat. IDF is computed over the
          WHOLE deduped corpus (174 rows), so generic recurring nouns
          ("track", "melody") score low and lose to genuinely distinguishing
          operation verbs ("transpose", "harmonize", "swing", "humanize").
          A self-derived slot-noun blocklist (`textutil.derive_slot_nouns`)
          additionally excludes incidental track/instrument-name nouns
          (e.g. "hats") from ever winning as an anchor over the true verb.
  5. `build_skill`       — turn a cluster into a generic Skill: slots from
     each run's constant-vs-varying arg keys (checked empirically across
     every example in the cluster, not assumed), a template with
     `repeat_over` for varying runs, descriptions pulled verbatim from the
     MoshOps catalog's own per-command `desc`, and provenance row refs.
  6. `SEMANTIC_REFINERS`  — a small, explicitly-scoped set of overrides for
     the handful of clusters whose slots need router-computed values instead
     of user-provided ones (transpose/harmonize/crescendo/swing/humanize —
     "existing notes in this clip, transformed"; mute-all-but — "every
     track except these"; the bus family — "reuse this bus if it already
     exists"). Every other cluster (the majority) ships as the generic
     build produces it. See README.md's "Mining algorithm" section.

Nothing here fabricates a skill the corpus doesn't support: every emitted
Skill's `provenance` list names the exact corpus rows that produced it, and
`mine_test.py` asserts mining is byte-identical across repeated runs.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import moshops_catalog as mc  # noqa: E402
import textutil as tu  # noqa: E402
from schema import Skill, Slot, TemplateCommand  # noqa: E402

SERVICE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CORPUS_FILES = (
    SERVICE_DIR / "sft" / "assist_demonstrations.jsonl",
    SERVICE_DIR / "sft" / "r5_train_additions.jsonl",
    SERVICE_DIR / "sft" / "add_note_corrective.jsonl",
    SERVICE_DIR / "sft" / "a3b-r4-cuda_next_run_examples.rendered.jsonl",
)
LIBRARY_PATH = Path(__file__).resolve().parent / "library.jsonl"


# ── corpus loading ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Row:
    source: str  # file basename
    index: int  # line number (0-based)
    user: str
    commands: tuple[dict[str, Any], ...]

    @property
    def ref(self) -> str:
        return f"{self.source}#{self.index}"


@dataclass(frozen=True)
class Example:
    """One deduped (task, commands) pair, possibly cited by several raw rows."""

    user: str
    commands: tuple[dict[str, Any], ...]
    provenance: tuple[str, ...]


def load_corpus_rows(paths: tuple[Path, ...] = DEFAULT_CORPUS_FILES) -> list[Row]:
    rows: list[Row] = []
    for path in paths:
        if not path.exists():
            raise FileNotFoundError(f"corpus file not found: {path}")
        with path.open() as f:
            for i, line in enumerate(f):
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                messages = obj["messages"]
                user = next((m["content"] for m in messages if m["role"] == "user"), None)
                assistant = next((m["content"] for m in messages if m["role"] == "assistant"), None)
                if user is None or assistant is None:
                    continue
                try:
                    parsed = json.loads(assistant)
                except json.JSONDecodeError:
                    continue
                commands = tuple(parsed.get("commands", []) or ())
                if not commands:
                    continue
                rows.append(Row(source=path.name, index=i, user=user, commands=commands))
    return rows


def dedupe_rows(rows: list[Row]) -> list[Example]:
    def cmd_key(cmds: tuple[dict[str, Any], ...]) -> tuple:
        return tuple((c["command"], tuple(sorted(c["args"].items()))) for c in cmds)

    order: list[tuple[str, tuple]] = []
    groups: dict[tuple[str, tuple], list[Row]] = {}
    for r in rows:
        key = (r.user, cmd_key(r.commands))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(r)

    examples = []
    for key in order:
        members = groups[key]
        examples.append(
            Example(
                user=members[0].user,
                commands=members[0].commands,
                provenance=tuple(m.ref for m in members),
            )
        )
    return examples


# ── structural shape ─────────────────────────────────────────────────────

Run = tuple[str, str, frozenset]  # (command_name, "1"|"+", arg_key_signature)
Shape = tuple[Run, ...]


def struct_shape(commands: tuple[dict[str, Any], ...]) -> Shape:
    runs: list[Run] = []
    i = 0
    n = len(commands)
    while i < n:
        name = commands[i]["command"]
        j = i
        keys: set[str] = set()
        while j < n and commands[j]["command"] == name:
            keys |= set(commands[j]["args"].keys())
            j += 1
        mult = "1" if (j - i) == 1 else "+"
        runs.append((name, mult, frozenset(keys)))
        i = j
    return tuple(runs)


def has_repeat(shape: Shape) -> bool:
    return any(mult == "+" for _, mult, _ in shape)


def notes_traceable(example: Example) -> bool:
    """True iff every `pitch` value in the example's commands, in order, is
    exactly reconstructible from explicit note names in the task text."""
    pitches = [c["args"]["pitch"] for c in example.commands if "pitch" in c.get("args", {})]
    if not pitches:
        return False
    parsed = tu.parse_note_names(example.user)
    return parsed == pitches


EXPLICIT_NOTES_ANCHOR = "(explicit-note-names)"


def keyword_split(
    examples: list[Example], global_df: dict[str, float], n_docs: int, blocklist: set[str]
) -> list[tuple[Optional[str], list[Example]]]:
    """Greedy TF-IDF anchor split. Deterministic: ties broken by (count, token)."""
    row_tokens = [set(tu.tokenize(e.user)) for e in examples]
    unassigned = set(range(len(examples)))
    clusters: list[tuple[Optional[str], list[int]]] = []
    while unassigned:
        cand_scores: dict[str, int] = {}
        for idx in unassigned:
            for t in row_tokens[idx]:
                if t in blocklist:
                    continue
                cand_scores[t] = cand_scores.get(t, 0) + 1
        if not cand_scores:
            for idx in sorted(unassigned):
                clusters.append((None, [idx]))
            break

        def score(t: str) -> tuple[float, int, str]:
            df = global_df.get(t, 1.0)
            import math

            idf = math.log((n_docs + 1) / (df + 1)) + 1
            return (cand_scores[t] * idf, cand_scores[t], t)

        best = max(cand_scores.keys(), key=score)
        members = [idx for idx in sorted(unassigned) if best in row_tokens[idx]]
        clusters.append((best, members))
        unassigned -= set(members)
    return [(anchor, [examples[i] for i in idxs]) for anchor, idxs in clusters]


@dataclass(frozen=True)
class Cluster:
    shape: Shape
    anchor: Optional[str]
    examples: tuple[Example, ...]


def cluster_examples(examples: list[Example]) -> list[Cluster]:
    """The full clustering pipeline (pure — no file I/O), steps 3-4 above."""
    n_docs = len(examples)
    blocklist = tu.derive_slot_nouns([e.user for e in examples]) | tu.STOPWORDS
    global_df = tu.idf_table([e.user for e in examples])
    # idf_table returns idf, not df; keyword_split wants df — recompute df directly
    # (kept separate from idf_table so textutil's idf_table stays reusable as-is).
    from collections import Counter

    df: Counter[str] = Counter()
    for e in examples:
        df.update(set(tu.tokenize(e.user)))

    buckets: dict[Shape, list[Example]] = {}
    for e in examples:
        buckets.setdefault(struct_shape(e.commands), []).append(e)

    clusters: list[Cluster] = []
    for shape, bucket in buckets.items():
        if len(bucket) == 1 or not has_repeat(shape):
            clusters.append(Cluster(shape=shape, anchor=None, examples=tuple(bucket)))
            continue

        pitch_run = any(mult == "+" and "pitch" in keys for _, mult, keys in shape)
        remaining = bucket
        if pitch_run:
            traceable = [e for e in bucket if notes_traceable(e)]
            remaining = [e for e in bucket if not notes_traceable(e)]
            if traceable:
                clusters.append(
                    Cluster(shape=shape, anchor=EXPLICIT_NOTES_ANCHOR, examples=tuple(traceable))
                )

        if not remaining:
            continue
        if len(remaining) == 1:
            clusters.append(Cluster(shape=shape, anchor=None, examples=tuple(remaining)))
            continue

        for anchor, members in keyword_split(remaining, df, n_docs, blocklist):
            clusters.append(Cluster(shape=shape, anchor=anchor, examples=tuple(members)))

    # deterministic order: largest first, ties broken by shape text then anchor
    clusters.sort(key=lambda c: (-len(c.examples), _shape_text(c.shape), c.anchor or ""))
    return clusters


def _shape_text(shape: Shape) -> str:
    return "+".join(f"{n}{'*' if m == '+' else ''}" for n, m, _ in shape)


# ── generic skill construction ───────────────────────────────────────────

# Glue/identity arg names: when constant-within-a-row, these are simple
# reference slots (not part of a repeat body) regardless of which command
# they appear on.
_GLUE_KEYS = frozenset({"clipId", "trackId"})


def _arg_key_constancy(examples: list[Example], cmd_name: str) -> tuple[set[str], set[str]]:
    """(const_keys, varying_keys) for one command name, checked empirically
    across every occurrence in every example (constant WITHIN a row's own
    repeat block; the row-to-row value may of course differ — that's what
    makes it a slot)."""
    const_keys: Optional[set[str]] = None
    varying_keys: set[str] = set()
    for e in examples:
        occurrences = [c["args"] for c in e.commands if c["command"] == cmd_name]
        if not occurrences:
            continue
        all_keys: set[str] = set()
        for args in occurrences:
            all_keys |= set(args.keys())
        row_const = set()
        for k in all_keys:
            values = [args.get(k, _MISSING) for args in occurrences]
            if all(v == values[0] and v is not _MISSING for v in values):
                row_const.add(k)
            else:
                varying_keys.add(k)
        const_keys = row_const if const_keys is None else (const_keys & row_const)
    return (const_keys or set()), varying_keys


_MISSING = object()


def _slot_type_for(cmd_name: str, arg_name: str, catalog: mc.Catalog) -> str:
    spec = catalog.get(cmd_name)
    if spec is None:
        return "string"
    for a in spec.args:
        if a.name == arg_name:
            return a.type
    return "string"


def _slot_required_for(cmd_name: str, arg_name: str, catalog: mc.Catalog) -> bool:
    spec = catalog.get(cmd_name)
    if spec is None:
        return True
    for a in spec.args:
        if a.name == arg_name:
            return a.required
    return True


def build_description(shape: Shape, catalog: mc.Catalog) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for cmd_name, mult, _ in shape:
        if cmd_name in seen:
            continue
        seen.add(cmd_name)
        spec = catalog.get(cmd_name)
        text = spec.desc if spec else cmd_name
        if mult == "+":
            text = f"{text} (repeated over a list)"
        parts.append(text)
    return "; then ".join(parts)


def build_name(shape: Shape, anchor: Optional[str], used_names: set[str]) -> str:
    parts: list[str] = []
    seen: set[str] = set()
    for cmd_name, _, _ in shape:
        k = tu.kebab(cmd_name)
        if k not in seen:
            parts.append(k)
            seen.add(k)
    base = "-".join(parts)

    if anchor == EXPLICIT_NOTES_ANCHOR:
        base = f"{base}-from-note-names"
    elif anchor:
        a = tu.kebab(anchor)
        if a and a not in base:
            base = f"{base}-{a}"
    elif has_repeat(shape):
        # no textual anchor (a singleton cluster) — fall back to the
        # distinguishing varying arg-key(s) so near-identical shapes (e.g.
        # set_note keyed only by pitch vs only by velocity) don't collide.
        hint_parts = []
        for _, mult, keys in shape:
            if mult != "+":
                continue
            distinguishing = sorted(keys - _GLUE_KEYS - {"noteIndex"})
            hint_parts.extend(distinguishing)
        if hint_parts:
            base = f"{base}-{'-'.join(tu.kebab(h) for h in hint_parts)}"

    name = base
    if name in used_names:
        i = 2
        while f"{name}-{i}" in used_names:
            i += 1
        name = f"{name}-{i}"
    used_names.add(name)
    return name


def _representative_value(examples: list[Example], cmd_name: str, key: str) -> Any:
    """The most common value of `key` across every `cmd_name` occurrence in
    the cluster (mode; ties broken by first occurrence, for determinism).
    Feeds Slot.default — a provenance-grounded fallback, never invented."""
    from collections import Counter

    values: list[Any] = []
    for e in examples:
        for c in e.commands:
            if c["command"] == cmd_name and key in c.get("args", {}):
                values.append(c["args"][key])
    if not values:
        return None
    counts = Counter(values)
    best_count = max(counts.values())
    for v in values:  # first-seen among the tied-best, deterministic
        if counts[v] == best_count:
            return v
    return values[0]


def _representative_items(examples: list[Example], cmd_name: str, keys: set[str]) -> list[dict[str, Any]]:
    """The first example's own list of {key: value} dicts for repeated calls
    to `cmd_name` — a deterministic, provenance-grounded 'preset' default for
    a list<param> slot (e.g. the exact EQ/compressor param values the corpus
    demonstrated for that effect, or a default note pattern)."""
    e = examples[0]
    return [
        {k: c["args"][k] for k in sorted(keys) if k in c["args"]}
        for c in e.commands
        if c["command"] == cmd_name
    ]


def build_skill(
    cluster: Cluster, catalog: mc.Catalog, used_names: set[str], global_idf: dict[str, float]
) -> Skill:
    """Generic construction: every constant-within-row arg becomes a scalar
    slot; every varying arg on a repeated run becomes a repeat-body field
    on a `list<...>` slot filled generically by the router."""
    examples = list(cluster.examples)
    slots: list[Slot] = []
    seen_slot_names: set[str] = set()
    template: list[TemplateCommand] = []

    for cmd_name, mult, _keys in cluster.shape:
        const_keys, varying_keys = _arg_key_constancy(examples, cmd_name)
        args: dict[str, Any] = {}
        for k in sorted(const_keys):
            if k not in seen_slot_names:
                slots.append(
                    Slot(
                        name=k,
                        type=_slot_type_for(cmd_name, k, catalog),
                        required=_slot_required_for(cmd_name, k, catalog),
                        description=f"{cmd_name}.{k}",
                        source="user",
                        default=_representative_value(examples, cmd_name, k),
                    )
                )
                seen_slot_names.add(k)
            args[k] = f"{{{k}}}"

        repeat_over = None
        if mult == "+" and varying_keys:
            list_slot_name = f"{cmd_name}Items"
            if list_slot_name not in seen_slot_names:
                slots.append(
                    Slot(
                        name=list_slot_name,
                        type="list<param>",
                        required=True,
                        description=f"one entry per {cmd_name} call: {sorted(varying_keys)}",
                        source="user",
                        default=_representative_items(examples, cmd_name, varying_keys),
                    )
                )
                seen_slot_names.add(list_slot_name)
            repeat_over = list_slot_name
            for k in sorted(varying_keys):
                args[k] = f"{{item.{k}}}"
        elif varying_keys:
            # mult == '1' but keys still vary across examples (optional args
            # sometimes present) — surface each as its own optional slot.
            for k in sorted(varying_keys):
                if k not in seen_slot_names:
                    slots.append(
                        Slot(
                            name=k,
                            type=_slot_type_for(cmd_name, k, catalog),
                            required=False,
                            description=f"{cmd_name}.{k}",
                            source="user",
                            default=_representative_value(examples, cmd_name, k),
                        )
                    )
                    seen_slot_names.add(k)
                args[k] = f"{{{k}}}"

        template.append(TemplateCommand(command=cmd_name, args=args, repeat_over=repeat_over))

    name = build_name(cluster.shape, cluster.anchor, used_names)
    description = build_description(cluster.shape, catalog)
    preconditions = _generic_preconditions(seen_slot_names)
    postconditions: list[dict[str, Any]] = []
    provenance = tuple(sorted({p for e in examples for p in e.provenance}))

    return Skill(
        name=name,
        description=description,
        slots=tuple(slots),
        template=tuple(template),
        preconditions=tuple(preconditions),
        postconditions=tuple(postconditions),
        provenance=provenance,
        triggers=tuple(derive_triggers(examples, global_idf)),
    )


def _generic_preconditions(slot_names: set[str]) -> list[dict[str, Any]]:
    preconditions: list[dict[str, Any]] = []
    if "trackId" in slot_names:
        preconditions.append({"type": "track_exists", "track_slot": "trackId"})
    if "clipId" in slot_names:
        preconditions.append({"type": "clip_exists", "clip_slot": "clipId"})
    return preconditions


def derive_triggers(examples: list[Example], global_idf: dict[str, float], top_k: int = 16) -> list[str]:
    """A small, deterministic bag of the cluster's own most distinguishing
    words (count-in-cluster weighted by corpus-WIDE rarity), used by the
    router for lexical retrieval.

    `global_idf` MUST come from the whole deduped corpus, not just this
    cluster: a word that recurs across MANY different clusters ("track",
    "the melody") is exactly the kind of word that should NOT dominate any
    one skill's trigger bag, because it can otherwise let a skill with a
    tiny, generic trigger set (e.g. a 1-example skill whose only triggers
    happen to include "track") outscore a properly-matching, larger skill
    at router time purely on a shared generic word. Ranking by raw in-
    cluster frequency (no rarity weighting) was tried first and produced
    exactly that failure — see router_test.py's held-out accuracy suite.
    """
    from collections import Counter

    texts = [e.user for e in examples]
    counts: Counter[str] = Counter()
    for t in texts:
        counts.update(set(tu.tokenize(t)))
    if not counts:
        return []
    ranked = sorted(counts.items(), key=lambda kv: (-(kv[1] * global_idf.get(kv[0], 1.0)), kv[0]))
    return [w for w, _ in ranked[:top_k]]


# ── semantic refiners ─────────────────────────────────────────────────────
# Each refiner: (predicate(cluster) -> bool, fn(skill, cluster, catalog) -> Skill).
# Applied in order; first match wins. Everything that matches none of these
# ships as the generic `build_skill` output above.


def _is_note_transform(cluster: Cluster, key: str) -> bool:
    """A repeated set_note run whose only varying key is `key` (pitch-only =
    transpose, velocity-only = crescendo, start-only = swing/humanize)."""
    for cmd_name, mult, keys in cluster.shape:
        if cmd_name == "set_note" and mult == "+":
            return keys == frozenset({"clipId", "noteIndex", key})
    return False


def _refine_transpose(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    slots = (
        Slot("clipId", "string", True, "the MIDI clip whose notes to transpose", "user"),
        Slot("semitones", "number", True, "signed semitone shift, e.g. -7 = down a fifth, +12 = up an octave", "user"),
        Slot("sourceNotes", "list<note>", True, "the clip's existing notes (index, pitch)", "computed"),
    )
    template = (
        TemplateCommand(
            "set_note",
            {"clipId": "{clipId}", "noteIndex": "{item.index}", "pitch": "{item.pitch}"},
            repeat_over="sourceNotes",
        ),
    )
    return _replace(
        skill,
        description="Transpose every existing note in a MIDI clip by a fixed interval (in place).",
        slots=slots,
        template=template,
        preconditions=(
            {"type": "clip_exists", "clip_slot": "clipId"},
            {"type": "clip_is_midi", "clip_slot": "clipId"},
        ),
    )


def _refine_crescendo(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    slots = (
        Slot("clipId", "string", True, "the MIDI clip whose notes to reshape", "user"),
        Slot("startVelocity", "number", False, "velocity of the first note (default a soft ~55)", "user", default=55),
        Slot("endVelocity", "number", False, "velocity of the last note (default 127, forte)", "user", default=127),
        Slot("sourceNotes", "list<note>", True, "the clip's existing notes (index) in order", "computed"),
    )
    template = (
        TemplateCommand(
            "set_note",
            {"clipId": "{clipId}", "noteIndex": "{item.index}", "velocity": "{item.velocity}"},
            repeat_over="sourceNotes",
        ),
    )
    return _replace(
        skill,
        description="Ramp a MIDI clip's note velocities linearly from soft to loud (a crescendo).",
        slots=slots,
        template=template,
        preconditions=(
            {"type": "clip_exists", "clip_slot": "clipId"},
            {"type": "clip_is_midi", "clip_slot": "clipId"},
        ),
    )


def _refine_swing_or_humanize(name_hint: str, description: str):
    def _refine(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
        slots = (
            Slot("clipId", "string", True, "the MIDI clip whose notes to nudge", "user"),
            Slot("amount", "number", False, "0-100 strength (swing %, or humanize intensity)", "user"),
            Slot("sourceNotes", "list<note>", True, "the notes selected for nudging (index, new start)", "computed"),
        )
        template = (
            TemplateCommand(
                "set_note",
                {"clipId": "{clipId}", "noteIndex": "{item.index}", "start": "{item.start}"},
                repeat_over="sourceNotes",
            ),
        )
        return _replace(
            skill,
            description=description,
            slots=slots,
            template=template,
            preconditions=(
                {"type": "clip_exists", "clip_slot": "clipId"},
                {"type": "clip_is_midi", "clip_slot": "clipId"},
            ),
        )

    return _refine


def _is_layer_octave(cluster: Cluster) -> bool:
    for cmd_name, mult, keys in cluster.shape:
        if cmd_name == "add_note" and mult == "+":
            return cluster.anchor not in (None, EXPLICIT_NOTES_ANCHOR) and cluster.anchor == "octave"
    return False


def _refine_layer_octave(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    slots = (
        Slot("clipId", "string", True, "the MIDI clip to layer", "user"),
        Slot("semitones", "number", False, "interval to layer at, default +12 (an octave up)", "user", default=12),
        Slot("sourceNotes", "list<note>", True, "the clip's existing notes, copied and shifted", "computed"),
    )
    template = (
        TemplateCommand(
            "add_note",
            {
                "clipId": "{clipId}",
                "pitch": "{item.pitch}",
                "start": "{item.start}",
                "length": "{item.length}",
                "velocity": "{item.velocity}",
            },
            repeat_over="sourceNotes",
        ),
    )
    return _replace(
        skill,
        description="Duplicate a MIDI clip's existing notes at a fixed interval (default an octave up), layering rather than replacing.",
        slots=slots,
        template=template,
        preconditions=(
            {"type": "clip_exists", "clip_slot": "clipId"},
            {"type": "clip_is_midi", "clip_slot": "clipId"},
        ),
    )


def _is_harmonize(cluster: Cluster) -> bool:
    for cmd_name, mult, _ in cluster.shape:
        if cmd_name == "add_note" and mult == "+":
            return cluster.anchor == "thirds"
    return False


def _refine_harmonize(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    slots = (
        Slot("clipId", "string", True, "the MIDI clip to harmonize", "user"),
        Slot("intervals", "list<number>", False, "semitone intervals to stack, default [4, 7] (a third + a fifth)", "user", default=[4, 7]),
        Slot("sourceNotes", "list<note>", True, "harmony notes computed from the clip's existing notes", "computed"),
    )
    template = (
        TemplateCommand(
            "add_note",
            {
                "clipId": "{clipId}",
                "pitch": "{item.pitch}",
                "start": "{item.start}",
                "length": "{item.length}",
                "velocity": "{item.velocity}",
            },
            repeat_over="sourceNotes",
        ),
    )
    return _replace(
        skill,
        description="Add harmony notes above a MIDI clip's existing melody at fixed intervals (default a third and a fifth).",
        slots=slots,
        template=template,
        preconditions=(
            {"type": "clip_exists", "clip_slot": "clipId"},
            {"type": "clip_is_midi", "clip_slot": "clipId"},
        ),
    )


def _is_mute_except(cluster: Cluster) -> bool:
    for cmd_name, mult, keys in cluster.shape:
        if cmd_name == "set_track_mute" and mult == "+":
            return True
    return False


def _refine_mute_except(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    slots = (
        Slot("keepTrackIds", "list<string>", True, "tracks to leave unmuted (matched by name from the task text)", "user"),
        Slot("targetTrackIds", "list<string>", True, "every other track in the session (computed)", "computed"),
    )
    template = (
        TemplateCommand(
            "set_track_mute",
            {"trackId": "{item.trackId}", "mute": True},
            repeat_over="targetTrackIds",
        ),
    )
    return _replace(
        skill,
        description="Mute every track except a named few (e.g. 'mute everything but the drums and bass').",
        slots=slots,
        template=template,
        preconditions=({"type": "always"},),
    )


def _is_bus_family(cluster: Cluster) -> bool:
    return cluster.shape[0][0] == "create_bus"


def _refine_bus_family(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    """create_bus[+] + add_send[+] [+ set_send_level | + remove_send] — reuse
    an existing same-name bus instead of blindly re-creating it. There are
    four distinct shapes actually observed in the corpus (bus mult, send
    mult, and an optional third command each vary independently), so this
    branches on the real per-run multiplicities rather than assuming one:
      - one bus,  one send                       -> route-to-bus
      - one bus,  one send, + set_send_level      -> adjust-send-level
      - one bus,  one send, + remove_send         -> remove-from-bus
      - one bus,  MANY sends (repeated add_send)  -> route-many-tracks-to-one-bus
      - MANY buses, MANY sends (1:1 pairs)        -> route-one-track-to-many-buses
    """
    cmd_names = [c for c, _, _ in cluster.shape]
    tail = cmd_names[2:]
    bus_mult = cluster.shape[0][1]
    send_mult = cluster.shape[1][1]

    if bus_mult == "+" and send_mult == "+":
        slots: tuple[Slot, ...] = (
            Slot("trackId", "string", True, "track to route", "user"),
            Slot("busNames", "list<string>", True, "bus names to route the track into, e.g. ['Reverb','Delay']", "user"),
            Slot("busIndices", "list<number>", True, "indices of the (existing or about-to-be-created) buses", "computed"),
        )
        template: tuple[TemplateCommand, ...] = (
            TemplateCommand(
                "create_bus",
                {"name": "{item.name}"},
                repeat_over="busNames",
                emit_if={"type": "bus_missing", "name_slot": "item.name"},
            ),
            TemplateCommand("add_send", {"trackId": "{trackId}", "bus": "{item.index}"}, repeat_over="busIndices"),
        )
        description = "Route one track to two or more buses at once, reusing any that already exist"
    elif bus_mult == "1" and send_mult == "+":
        slots = (
            Slot("busName", "string", False, "bus name, default 'Reverb'", "user", default="Reverb"),
            Slot("trackIds", "list<string>", True, "tracks to route into the bus", "user"),
            Slot("busIndex", "number", True, "index of the (existing or about-to-be-created) bus", "computed"),
        )
        template = (
            TemplateCommand(
                "create_bus", {"name": "{busName}"}, emit_if={"type": "bus_missing", "name_slot": "busName"}
            ),
            TemplateCommand("add_send", {"trackId": "{item.trackId}", "bus": "{busIndex}"}, repeat_over="trackIds"),
        )
        description = "Route two or more tracks into one bus at once, reusing it if it already exists"
    else:
        slots = (
            Slot("trackId", "string", True, "track to route", "user"),
            Slot("busName", "string", False, "bus name, default 'Reverb'", "user", default="Reverb"),
            Slot("db", "number", False, "send level in dB", "user"),
            Slot("busIndex", "number", True, "index of the (existing or about-to-be-created) bus", "computed"),
        )
        template = (
            TemplateCommand(
                "create_bus", {"name": "{busName}"}, emit_if={"type": "bus_missing", "name_slot": "busName"}
            ),
            TemplateCommand("add_send", {"trackId": "{trackId}", "bus": "{busIndex}", "db": "{db}"}),
        )
        description = "Route a track to a bus (reusing one with the same name if it already exists)"
        if "set_send_level" in tail:
            template = template + (
                TemplateCommand("set_send_level", {"trackId": "{trackId}", "bus": "{busIndex}", "db": "{db}"}),
            )
            description = "Adjust a track's send level to a bus, creating the bus first if needed"
        elif "remove_send" in tail:
            template = template + (
                TemplateCommand("remove_send", {"trackId": "{trackId}", "bus": "{busIndex}"}),
            )
            description = "Remove a track's send to a bus"

    return _replace(skill, description=description, slots=slots, template=template)


SEMANTIC_REFINERS: list[tuple[Any, Any]] = [
    (lambda c: _is_note_transform(c, "pitch"), _refine_transpose),
    (lambda c: _is_note_transform(c, "velocity"), _refine_crescendo),
    (
        lambda c: _is_note_transform(c, "start") and c.anchor == "swing",
        _refine_swing_or_humanize("swing", "Push the off-beat notes in a MIDI clip later, for a swing feel."),
    ),
    (
        lambda c: _is_note_transform(c, "start") and c.anchor == "humanize",
        _refine_swing_or_humanize("humanize", "Nudge non-anchor notes in a MIDI clip's timing slightly, so it feels less mechanical."),
    ),
    (_is_layer_octave, _refine_layer_octave),
    (_is_harmonize, _refine_harmonize),
    (_is_mute_except, _refine_mute_except),
    (_is_bus_family, _refine_bus_family),
]


def _replace(skill: Skill, **kwargs: Any) -> Skill:
    data = skill.__dict__.copy()
    data.update(kwargs)
    return Skill(**data)


def apply_refiners(skill: Skill, cluster: Cluster, catalog: mc.Catalog) -> Skill:
    for predicate, refine in SEMANTIC_REFINERS:
        if predicate(cluster):
            refined = refine(skill, cluster, catalog)
            # preserve mining-derived identity fields the refiner doesn't touch
            return _replace(
                refined,
                name=skill.name,
                provenance=skill.provenance,
                triggers=skill.triggers,
            )
    return skill


# ── top-level mining entry point ─────────────────────────────────────────


def build_library_from_examples(examples: list[Example], catalog: Optional[mc.Catalog] = None) -> list[Skill]:
    """Cluster + build + refine, skipping corpus loading/dedup. Exposed so
    tests can mine from an explicit (e.g. held-out-excluded) example set
    without re-reading files — see mine_test.py's held-out split."""
    catalog = catalog if catalog is not None else mc.load_catalog()
    clusters = cluster_examples(examples)
    global_idf = tu.idf_table([e.user for e in examples])
    used_names: set[str] = set()
    skills: list[Skill] = []
    for cluster in clusters:
        skill = build_skill(cluster, catalog, used_names, global_idf)
        skill = apply_refiners(skill, cluster, catalog)
        skills.append(skill)
    return skills


def mine_library(rows: list[Row], catalog: Optional[mc.Catalog] = None) -> list[Skill]:
    examples = dedupe_rows(rows)
    return build_library_from_examples(examples, catalog)


def write_library(skills: list[Skill], path: Path = LIBRARY_PATH) -> None:
    with path.open("w") as f:
        for skill in skills:
            f.write(json.dumps(skill.to_dict(), sort_keys=True))
            f.write("\n")


def main() -> None:
    rows = load_corpus_rows()
    skills = mine_library(rows)
    write_library(skills)
    print(f"mined {len(skills)} skills from {len(rows)} corpus rows -> {LIBRARY_PATH}")


if __name__ == "__main__":
    main()
