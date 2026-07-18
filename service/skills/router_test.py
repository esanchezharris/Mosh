#!/usr/bin/env python3
"""Gate tests for router.py: generic + special slot filling, precondition/
postcondition predicates, conjunction-aware composition, command validity —
and the main event, held-out router accuracy against a real train/test split
of the demonstration corpus (not the shipped library.jsonl, which is mined
from everything; this re-mines from an 80/20 split so the accuracy number
means something)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mine  # noqa: E402
import moshops_catalog as mc  # noqa: E402
import router  # noqa: E402
import textutil as tu  # noqa: E402
from schema import eval_predicate  # noqa: E402

CATALOG = mc.load_catalog()

# ── a snapshot rich enough to resolve every track name/number the corpus
#    ever mentions, so slot-filling has something real to resolve against ──

_TRACK_NAMES = [
    "Drums", "Bass", "Melody", "Vocal", "Keys", "Lead", "Guitar", "Piano",
    "Pad", "Strings", "Synth", "Horns", "Percs", "Beat", "Bounce", "Groove",
    "Chops", "Kick", "Hats",
]
_NUMERIC_TRACK_IDS = ["1011", "18", "17", "20"]


def make_snapshot() -> dict:
    tracks = []
    for i, name in enumerate(_TRACK_NAMES):
        kind = "drum" if name in ("Drums", "Kick", "Percs", "Beat") else "audio"
        tracks.append({"id": f"t{i}", "name": name, "type": kind})
    for tid in _NUMERIC_TRACK_IDS:
        tracks.append({"id": tid, "name": f"Track{tid}", "type": "audio"})

    def tid(name: str) -> str:
        return next(t["id"] for t in tracks if t["name"] == name)

    melody_notes = [
        {"pitch": 60, "start": 0, "length": 1, "velocity": 100},
        {"pitch": 64, "start": 1, "length": 1, "velocity": 100},
        {"pitch": 67, "start": 2, "length": 1, "velocity": 100},
        {"pitch": 72, "start": 3, "length": 1, "velocity": 100},
    ]
    hats_notes = [{"pitch": 42, "start": round(i * 0.333, 3), "length": 0.2, "velocity": 90} for i in range(12)]

    clips = [
        {"id": "c-melody", "trackId": tid("Melody"), "kind": "midi", "notes": melody_notes},
        {"id": "c-hats", "trackId": tid("Hats"), "kind": "midi", "notes": hats_notes},
    ]
    for name in _TRACK_NAMES:
        if name in ("Melody", "Hats"):
            continue
        clips.append({"id": f"c-{name.lower()}", "trackId": tid(name), "kind": "midi", "notes": []})
    for numeric_id in _NUMERIC_TRACK_IDS:
        clips.append({"id": f"c-{numeric_id}", "trackId": numeric_id, "kind": "midi", "notes": []})

    return {
        "tracks": tracks,
        "clips": clips,
        "buses": [],
        "selectedTrackId": tid("Vocal"),
        "selectedClipId": "c-vocal",
    }


SNAPSHOT = make_snapshot()


def _library() -> list:
    return router.load_library()


# ── retrieval ─────────────────────────────────────────────────────────────


def test_select_skill_picks_a_strong_match_for_a_clear_task():
    skills = _library()
    skill = router.select_skill("Put a built-in drum kit on the Drums track.", skills)
    assert skill is not None
    assert skill.name == "load-drum-kit"


def test_select_skill_returns_none_for_gibberish():
    skills = _library()
    assert router.select_skill("xyzzy plugh frotz", skills) is None


def test_rank_skills_is_deterministic():
    skills = _library()
    text = "swing the hats around 55%"
    a = [(c.skill.name, c.score) for c in router.rank_skills(text, skills)]
    b = [(c.skill.name, c.score) for c in router.rank_skills(text, skills)]
    assert a == b


# ── generic extractors ───────────────────────────────────────────────────


def test_find_track_mentions_by_name_and_by_number():
    hits = router.find_track_mentions("solo the Drums track", SNAPSHOT)
    assert hits and hits[0]["name"] == "Drums"
    hits = router.find_track_mentions("Turn track 1011 into a drum track", SNAPSHOT)
    assert hits and hits[0]["id"] == "1011"


def test_find_track_mentions_orders_by_first_occurrence():
    hits = router.find_track_mentions("route the drums and vocal into it", SNAPSHOT)
    names = [h["name"] for h in hits]
    assert names.index("Drums") < names.index("Vocal")


def test_extract_signed_interval_directions_and_names():
    assert router.extract_signed_interval("transpose the melody down a fifth") == -7
    assert router.extract_signed_interval("double the melody up an octave") == 12
    assert router.extract_signed_interval("shift it up a third") == 4
    assert router.extract_signed_interval("drop it down 3 semitones") == -3
    assert router.extract_signed_interval("no interval words here") is None


def test_extract_db_pan_percent_fraction():
    assert tu.extract_db("bring it down 3 dB") == 3.0
    assert tu.extract_db("send it at -6 dB") == -6.0
    assert router.extract_pan("pan it hard left") == -1.0
    assert router.extract_pan("pan it a bit to the left") == -0.5
    assert tu.extract_percent("swing the hats around 55%") == 55.0
    assert tu.extract_fraction("switch to 3/4 time") == (3, 4)


def test_extract_ordinal_index_is_zero_based():
    assert router.extract_ordinal_index("switch to the second take") == 1
    assert router.extract_ordinal_index("switch to the first take") == 0
    assert router.extract_ordinal_index("switch to take 3") == 2


def test_notes_from_names_parses_and_spaces_notes():
    items = router.notes_from_names("play these notes on the Melody: G4, A4, B4")
    assert [n["pitch"] for n in items] == [67, 69, 71]
    assert items[0]["start"] == 0.0
    assert items[1]["start"] == 0.5


# ── generic routing across representative single-command skills ────────


_GENERIC_CASES = [
    ("Put a built-in drum kit on the Drums track.", "load_drum_kit"),
    ("solo the drums", "set_track_solo"),
    ("rename the melody track to Lead", "rename_track"),
    ("set the tempo to 90", "set_tempo"),
    ("switch to 3/4 time", "set_time_signature"),
    ("arm the vocal track for recording", "arm_track"),
    ("scrap that last take", "stop_recording"),
    ("turn on input monitoring for the vocal", "set_input_monitor"),
    ("show me the takes on the vocal clip", "list_takes"),
    ("switch to the second take on the vocal", "set_current_take"),
    ("pan the melody a bit to the left", "set_track_pan"),
]


def test_generic_single_command_skills_route_and_validate():
    skills = _library()
    for text, expected_command in _GENERIC_CASES:
        r = router.route(text, SNAPSHOT, skills, CATALOG)
        assert r.ok, f"{text!r} failed: {r.errors}"
        assert any(c["command"] == expected_command for c in r.commands), (text, r.commands)
        errs = router.validate_commands(r.commands, CATALOG)
        assert not errs, (text, errs)


def test_assign_sample_fills_file_note_and_mode():
    skills = _library()
    r = router.route(
        "Map /Users/x/Music/kick.wav to the Drums track on note 36 so I can trigger it from the kit.",
        SNAPSHOT, skills, CATALOG,
    )
    assert r.ok
    (cmd,) = r.commands
    assert cmd["command"] == "assign_sample"
    assert cmd["args"]["file"] == "/Users/x/Music/kick.wav"
    assert cmd["args"]["note"] == 36
    assert cmd["args"]["mode"] == "drum"

    r2 = router.route(
        "Load /Users/x/Music/loop.wav onto the Lead track on note 48 and make it melodic so it follows the keyboard.",
        SNAPSHOT, skills, CATALOG,
    )
    assert r2.ok
    assert r2.commands[0]["args"]["mode"] == "melodic"


def test_write_note_pattern_falls_back_to_default_when_no_explicit_notes():
    skills = _library()
    r = router.route("write a quick pattern on the Melody", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert r.skill_names == ("add-note-pattern",)
    assert all(c["command"] == "add_note" for c in r.commands)
    assert len(r.commands) >= 1


# ── special fillers: note transforms ────────────────────────────────────


def test_transpose_shifts_every_existing_note_by_the_same_interval():
    skills = _library()
    r = router.route("transpose the melody down a fifth", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert r.skill_names == ("set-note-pitch",)
    original = [n["pitch"] for n in SNAPSHOT["clips"][0]["notes"]]
    got = [c["args"]["pitch"] for c in r.commands]
    assert got == [p - 7 for p in original]
    assert all(c["command"] == "set_note" for c in r.commands)


def test_layer_octave_adds_new_notes_without_removing_originals():
    skills = _library()
    r = router.route("double the melody up an octave", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert all(c["command"] == "add_note" for c in r.commands)  # add, not overwrite
    original = SNAPSHOT["clips"][0]["notes"]
    assert [c["args"]["pitch"] for c in r.commands] == [n["pitch"] + 12 for n in original]
    assert [c["args"]["start"] for c in r.commands] == [n["start"] for n in original]


def test_crescendo_ramps_velocity_monotonically():
    skills = _library()
    r = router.route("make the melody crescendo", SNAPSHOT, skills, CATALOG)
    assert r.ok
    velocities = [c["args"]["velocity"] for c in r.commands]
    assert velocities == sorted(velocities)
    assert velocities[0] < velocities[-1]
    assert velocities[-1] <= 127


def test_harmonize_adds_two_notes_per_original_at_softer_velocity():
    skills = _library()
    r = router.route("harmonize the melody with thirds and fifths", SNAPSHOT, skills, CATALOG)
    assert r.ok
    original = SNAPSHOT["clips"][0]["notes"]
    assert len(r.commands) == 2 * len(original)
    for c in r.commands:
        assert c["args"]["velocity"] < 100  # softer than the original notes' velocity


def test_swing_and_humanize_are_distinct_skills_that_only_touch_start():
    skills = _library()
    swing = router.route("swing the hats around 55%", SNAPSHOT, skills, CATALOG)
    humanize = router.route("humanize the hats", SNAPSHOT, skills, CATALOG)
    assert swing.ok and humanize.ok
    assert swing.skill_names == ("set-note-swing",)
    assert humanize.skill_names == ("set-note-humanize",)
    assert swing.skill_names != humanize.skill_names
    for c in swing.commands + humanize.commands:
        assert set(c["args"].keys()) == {"clipId", "noteIndex", "start"}


# ── special fillers: mute-except + bus family ───────────────────────────


def test_mute_except_mutes_every_track_but_the_named_ones():
    skills = _library()
    r = router.route("mute everything but the drums and bass", SNAPSHOT, skills, CATALOG)
    assert r.ok
    muted_ids = {c["args"]["trackId"] for c in r.commands}
    drums_id = next(t["id"] for t in SNAPSHOT["tracks"] if t["name"] == "Drums")
    bass_id = next(t["id"] for t in SNAPSHOT["tracks"] if t["name"] == "Bass")
    assert drums_id not in muted_ids
    assert bass_id not in muted_ids
    all_ids = {t["id"] for t in SNAPSHOT["tracks"]}
    assert muted_ids == all_ids - {drums_id, bass_id}


def test_bus_family_creates_a_new_bus_when_none_exists():
    skills = _library()
    r = router.route("send the vocal to a new reverb bus at -6 dB", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert any(c["command"] == "create_bus" for c in r.commands)


def test_bus_family_reuses_an_existing_bus_instead_of_recreating_it():
    skills = _library()
    snap = {**SNAPSHOT, "buses": [{"index": 0, "name": "Reverb"}]}
    r = router.route("send the vocal to a new reverb bus at -6 dB", snap, skills, CATALOG)
    assert r.ok
    assert not any(c["command"] == "create_bus" for c in r.commands), r.commands
    add_send = next(c for c in r.commands if c["command"] == "add_send")
    assert add_send["args"]["bus"] == 0


# ── preconditions / postconditions ──────────────────────────────────────


def test_eval_predicate_track_and_clip_existence():
    assert eval_predicate({"type": "track_exists", "track_slot": "trackId"}, SNAPSHOT, {"trackId": "t0"})
    assert not eval_predicate({"type": "track_exists", "track_slot": "trackId"}, SNAPSHOT, {"trackId": "nope"})
    assert eval_predicate({"type": "clip_exists", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c-melody"})
    assert eval_predicate({"type": "clip_is_midi", "clip_slot": "clipId"}, SNAPSHOT, {"clipId": "c-melody"})
    assert eval_predicate({"type": "always"}, SNAPSHOT, {})


def test_eval_predicate_bus_missing_and_exists():
    empty = {"buses": []}
    full = {"buses": [{"index": 0, "name": "Reverb"}]}
    pred = {"type": "bus_missing", "name_slot": "busName"}
    assert eval_predicate(pred, empty, {"busName": "Reverb"})
    assert not eval_predicate(pred, full, {"busName": "Reverb"})
    exists_pred = {"type": "bus_exists", "name_slot": "busName"}
    assert eval_predicate(exists_pred, full, {"busName": "Reverb"})
    assert not eval_predicate(exists_pred, empty, {"busName": "Reverb"})


def test_route_single_fails_a_clip_scoped_skill_on_a_track_with_no_clip():
    skills = _library()
    bare_snapshot = {"tracks": [{"id": "t0", "name": "Melody", "type": "audio"}], "clips": [], "buses": []}
    r = router.route_single("transpose the melody down a fifth", bare_snapshot, skills, CATALOG)
    assert not r.ok
    assert r.errors


def test_every_skills_preconditions_evaluate_without_raising():
    skills = _library()
    for s in skills:
        for p in s.preconditions:
            eval_predicate(p, SNAPSHOT, {"trackId": "t0", "clipId": "c-melody"})
        for tc in s.template:
            if tc.emit_if is not None:
                name_slot = tc.emit_if.get("name_slot", "")
                probe_slot = "__item_value__" if name_slot.startswith("item.") else name_slot
                pred = dict(tc.emit_if, name_slot=probe_slot)
                eval_predicate(pred, SNAPSHOT, {probe_slot: "Reverb"})


# ── composition ──────────────────────────────────────────────────────────


def test_composition_chains_two_genuinely_independent_intents():
    skills = _library()
    r = router.route("solo the drums and set the tempo to 90", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert set(r.skill_names) == {"set-track-solo", "set-tempo"}
    assert len(r.commands) == 2


def test_composition_does_not_fire_on_a_single_listy_intent():
    skills = _library()
    r = router.route("mute everything but the drums and bass", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert r.skill_names == ("set-track-mute-mute",)


def test_composition_does_not_fire_when_the_whole_sentence_is_one_minted_skills_own_text():
    skills = _library()
    r = router.route("arm the vocal and start recording", SNAPSHOT, skills, CATALOG)
    assert r.ok
    assert r.skill_names == ("arm-track-set-transport",)
    assert len(r.commands) == 2


def test_route_reports_errors_for_unroutable_text():
    skills = _library()
    r = router.route("this sentence matches absolutely nothing in the library whatsoever", SNAPSHOT, skills, CATALOG)
    assert not r.ok
    assert r.errors


# ── the main event: held-out router accuracy on a real train/test split ──


def _full_clustering_ground_truth() -> tuple[list, dict[str, str]]:
    """Cluster the WHOLE corpus once (independent of any train/test split)
    to know, for every single corpus row, which skill it 'true-belongs' to."""
    rows = mine.load_corpus_rows()
    examples = mine.dedupe_rows(rows)
    full_skills = mine.build_library_from_examples(examples, CATALOG)
    ground_truth: dict[str, str] = {}
    for s in full_skills:
        for ref in s.provenance:
            ground_truth[ref] = s.name
    return examples, ground_truth


def _held_out_split(examples: list, min_cluster_size: int = 5, holdout_frac: float = 0.2):
    """Deterministically hold out ~20% of each cluster with >= min_cluster_size
    examples; every smaller cluster (most of them — see mine.py's docstring:
    many skills here have exactly one canonical demonstration) stays entirely
    in train, since holding out its only example would erase the skill from
    the trained library and make 'did the router pick it' unanswerable."""
    clusters = mine.cluster_examples(examples)
    train: list = []
    held_out: list = []
    for c in clusters:
        members = sorted(c.examples, key=lambda e: e.provenance[0])
        if len(members) >= min_cluster_size:
            n_hold = max(1, round(len(members) * holdout_frac))
            train.extend(members[:-n_hold])
            held_out.extend(members[-n_hold:])
        else:
            train.extend(members)
    return train, held_out


def test_held_out_split_is_a_true_partition_and_nontrivial():
    examples, _ = _full_clustering_ground_truth()
    train, held_out = _held_out_split(examples)
    assert len(train) + len(held_out) == len(examples)
    train_refs = {p for e in train for p in e.provenance}
    held_refs = {p for e in held_out for p in e.provenance}
    assert not (train_refs & held_refs)
    assert len(held_out) >= 15, "held-out slice should be a meaningful sample"


def test_train_only_mining_reproduces_the_same_skill_names_for_untouched_clusters():
    """Sanity check the split methodology itself: removing the held-out 20%
    from the big clusters must not rename the small/untouched ones (needed
    for the ground-truth-by-name comparison below to be meaningful)."""
    examples, ground_truth = _full_clustering_ground_truth()
    train, _ = _held_out_split(examples)
    train_skills = mine.build_library_from_examples(train, CATALOG)
    train_names = {s.name for s in train_skills}
    full_names = set(ground_truth.values())
    # every name the full run produced for a cluster with untouched members
    # must still be produced by the train-only run
    missing = full_names - train_names
    assert not missing, f"train-only mining dropped/renamed clusters: {missing}"


def test_router_accuracy_on_held_out_corpus_slice():
    examples, ground_truth = _full_clustering_ground_truth()
    train_examples, held_out_examples = _held_out_split(examples)
    train_skills = mine.build_library_from_examples(train_examples, CATALOG)

    total = len(held_out_examples)
    correct = 0
    commands_valid = 0
    failures = []
    for e in held_out_examples:
        expected_name = ground_truth[e.provenance[0]]
        r = router.route_single(e.user, SNAPSHOT, train_skills, CATALOG)
        got_name = r.skill_names[0] if r.skill_names else None
        if got_name == expected_name:
            correct += 1
        else:
            failures.append((e.user, expected_name, got_name, r.errors))
        if r.ok:
            errs = router.validate_commands(r.commands, CATALOG)
            if not errs:
                commands_valid += 1

    accuracy = correct / total
    command_validity_rate = commands_valid / total
    print(
        f"\nheld-out router accuracy: {correct}/{total} = {accuracy:.1%}; "
        f"command-valid rate: {commands_valid}/{total} = {command_validity_rate:.1%}"
    )
    if failures:
        print("misroutes (task, expected, got, errors):")
        for f in failures[:10]:
            print("  ", f)

    assert accuracy >= 0.80, f"held-out skill-selection accuracy too low: {accuracy:.1%}"
    assert command_validity_rate >= 0.80, f"held-out command-validity rate too low: {command_validity_rate:.1%}"


def test_held_out_accuracy_is_deterministic():
    examples, ground_truth = _full_clustering_ground_truth()
    train_examples, held_out_examples = _held_out_split(examples)
    train_skills = mine.build_library_from_examples(train_examples, CATALOG)

    def run():
        correct = 0
        for e in held_out_examples:
            r = router.route_single(e.user, SNAPSHOT, train_skills, CATALOG)
            expected = ground_truth[e.provenance[0]]
            got = r.skill_names[0] if r.skill_names else None
            correct += int(got == expected)
        return correct

    assert run() == run() == run()


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v", "-s"]))
