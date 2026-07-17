#!/usr/bin/env python3
"""Gate tests for mine.py: determinism, non-empty + schema-valid output,
command validity against the real MoshOps catalog, and honest provenance
(every cited row actually exists and actually uses the skill's commands)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mine  # noqa: E402
import moshops_catalog as mc  # noqa: E402
from schema import Skill, validate_skill_shape  # noqa: E402


def _catalog() -> mc.Catalog:
    return mc.load_catalog()


def _mine() -> list[Skill]:
    rows = mine.load_corpus_rows()
    return mine.mine_library(rows, catalog=_catalog())


# ── corpus loading sanity ────────────────────────────────────────────────


def test_corpus_files_exist_and_are_nonempty():
    for path in mine.DEFAULT_CORPUS_FILES:
        assert path.exists(), f"missing corpus file: {path}"
        assert path.stat().st_size > 0


def test_load_corpus_rows_matches_expected_row_counts():
    rows = mine.load_corpus_rows()
    by_file: dict[str, int] = {}
    for r in rows:
        by_file[r.source] = by_file.get(r.source, 0) + 1
    # every row in these files has an assistant "commands" array, so the
    # count should equal every jsonl line (spot-checked against `wc -l`).
    assert by_file["assist_demonstrations.jsonl"] == 35
    assert by_file["r5_train_additions.jsonl"] == 105
    assert by_file["add_note_corrective.jsonl"] == 40
    assert by_file["a3b-r4-cuda_next_run_examples.rendered.jsonl"] == 9
    assert len(rows) == 35 + 105 + 40 + 9


def test_dedupe_collapses_literal_duplicates_but_keeps_all_provenance():
    rows = mine.load_corpus_rows()
    examples = mine.dedupe_rows(rows)
    assert len(examples) < len(rows), "the corpus is known to repeat some rows verbatim across files"
    total_cited = sum(len(e.provenance) for e in examples)
    assert total_cited == len(rows), "every raw row must be cited as provenance by exactly one example"


# ── determinism (the gate's primary requirement) ────────────────────────


def test_mining_is_deterministic_across_three_runs():
    catalog = _catalog()
    rows = mine.load_corpus_rows()
    runs = [mine.mine_library(rows, catalog=catalog) for _ in range(3)]
    serialized = [[s.to_dict() for s in run] for run in runs]
    assert serialized[0] == serialized[1] == serialized[2]
    assert len(serialized[0]) > 0


def test_write_library_then_reload_round_trips():
    import tempfile

    skills = _mine()
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "library.jsonl"
        mine.write_library(skills, path)
        reloaded = []
        import json

        with path.open() as f:
            for line in f:
                reloaded.append(Skill.from_dict(json.loads(line)))
        assert [s.to_dict() for s in skills] == [s.to_dict() for s in reloaded]


# ── non-empty, bounded, schema-valid ─────────────────────────────────────


def test_library_size_is_in_the_useful_range():
    skills = _mine()
    assert 10 <= len(skills) <= 40, f"expected ~10-40 skills, got {len(skills)}"


def test_every_skill_is_schema_valid():
    skills = _mine()
    all_errors = []
    for s in skills:
        all_errors.extend(validate_skill_shape(s))
    assert not all_errors, "\n".join(all_errors)


def test_skill_names_are_unique():
    skills = _mine()
    names = [s.name for s in skills]
    assert len(names) == len(set(names)), f"duplicate skill names: {sorted(n for n in names if names.count(n) > 1)}"


def test_every_skill_has_a_nonempty_description_and_template():
    skills = _mine()
    for s in skills:
        assert s.description.strip()
        assert len(s.template) >= 1


# ── commands are valid against the real MoshOps catalog ────────────────


def test_every_template_command_is_a_real_moshops_command_with_required_args():
    skills = _mine()
    catalog = _catalog()
    errors = []
    for s in skills:
        for tc in s.template:
            spec = catalog.get(tc.command)
            if spec is None:
                errors.append(f"{s.name}: unknown command {tc.command!r}")
                continue
            missing = set(spec.required_args()) - set(tc.args.keys())
            if missing:
                errors.append(f"{s.name}: {tc.command} template missing required args {missing}")
            unknown = set(tc.args.keys()) - set(spec.arg_names())
            if unknown:
                errors.append(f"{s.name}: {tc.command} template has unknown args {unknown}")
    assert not errors, "\n".join(errors)


# ── provenance is real, not fabricated ──────────────────────────────────


def test_every_provenance_row_exists_in_the_corpus():
    skills = _mine()
    rows = mine.load_corpus_rows()
    real_refs = {r.ref for r in rows}
    errors = []
    for s in skills:
        for ref in s.provenance:
            if ref not in real_refs:
                errors.append(f"{s.name}: provenance {ref!r} does not correspond to a real corpus row")
    assert not errors, "\n".join(errors)


def test_every_skill_provenance_row_actually_uses_one_of_its_template_commands():
    """The strongest anti-fabrication check: don't just cite a row number —
    the cited row's own assistant commands must include a command the skill
    actually claims to perform."""
    skills = _mine()
    rows = {r.ref: r for r in mine.load_corpus_rows()}
    errors = []
    for s in skills:
        template_commands = {tc.command for tc in s.template}
        for ref in s.provenance:
            row = rows[ref]
            row_commands = {c["command"] for c in row.commands}
            if not (template_commands & row_commands):
                errors.append(
                    f"{s.name}: provenance {ref!r} uses commands {row_commands}, "
                    f"none of which are in the skill's template {template_commands}"
                )
    assert not errors, "\n".join(errors)


def test_no_skill_is_a_singleton_with_a_meaningless_shape():
    """Every mined skill must be backed by an actual repeated pattern OR a
    single canonical demonstration whose command sequence is itself
    meaningful (>=1 command, not empty)."""
    skills = _mine()
    for s in skills:
        assert len(s.provenance) >= 1
        assert len(s.template) >= 1


# ── cluster_examples is a pure function (usable for the held-out split in
#    router_test.py) — sanity check it agrees with mine_library's grouping ──


def test_cluster_examples_partitions_every_example_exactly_once():
    rows = mine.load_corpus_rows()
    examples = mine.dedupe_rows(rows)
    clusters = mine.cluster_examples(examples)
    seen_provenance: list[str] = []
    for c in clusters:
        for e in c.examples:
            seen_provenance.extend(e.provenance)
    all_provenance = [p for e in examples for p in e.provenance]
    assert sorted(seen_provenance) == sorted(all_provenance)


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
