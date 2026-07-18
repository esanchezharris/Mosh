#!/usr/bin/env python3
"""Golden test for build_add_note_corrective.py — row count + add_note-only shape.

Pins the AG-NOTE1 contract: ~40 rows, every emitted row a {system,user,assistant}
triple whose assistant commands are ALL add_note (never add_drum_pattern) with
valid clipId/pitch(0-127)/start/length/velocity(0-127) args, and the whole build is
deterministic (building twice in-process is byte-identical).

Run: python3 service/sft/build_add_note_corrective_test.py  (stdlib only, deterministic)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def check_entry_parser():
    """The catalog parser must survive an entry that WRAPS across source lines.

    Regression guard: the parser used to match the catalog line-by-line, so the
    moment a long entry was wrapped (set_clip_fade in #410, set_clip_loop in #425)
    it raised "parser drifted" and took every service-touching gate red with it.
    Wrapping is a formatting choice the catalog is free to make, so it must parse —
    while genuinely malformed input must still fail LOUD (the anti-invention
    guarantee: a command name can only be one actually found in commands.ts).
    """
    from build_add_note_corrective import _ENTRY_RE, _split_entries, parse_agent_commands

    # A wrapped entry parses to exactly one entry the regex accepts.
    wrapped = (
        '  { command: "set_clip_fade", desc: "Set a clip\'s fade-in / fade-out (seconds)",\n'
        '    args: [S("clipId"), N("fadeInSec", false, "seconds"),\n'
        '           S("curveIn", false, "linear|convex")] },'
    )
    got = _split_entries(wrapped)
    assert len(got) == 1, f"wrapped entry split into {len(got)}, expected 1"
    assert _ENTRY_RE.match(got[0]), f"wrapped entry still unparseable: {got[0]!r}"

    # Structure inside a string literal is not structure.
    assert len(_split_entries('{ command: "a", desc: "has {braces}", args: [S("x")] },')) == 1
    assert len(_split_entries('{ command: "b", desc: "say \\"hi\\"", args: [S("x")] },')) == 1

    # Adjacent entries stay separate.
    two = '{ command: "d", desc: "one", args: [S("x")] },\n{ command: "e", desc: "two", args: [S("y")] },'
    assert len(_split_entries(two)) == 2

    # Drift still fails loud rather than silently dropping an entry.
    try:
        _split_entries('{ command: "f", desc: "oops", args: [S("x")')
    except RuntimeError:
        pass
    else:
        raise AssertionError("unterminated entry did not raise — drift detection is broken")

    # And the real catalog parses, with the two historically-wrapped entries present.
    cmds = parse_agent_commands()
    names = [c.name for c in cmds]
    assert len(names) == len(set(names)), "duplicate command names — scanner double-counted"
    for required in ("set_clip_fade", "set_clip_loop"):
        assert required in names, f"{required} missing from parsed catalog"
    fade = next(c for c in cmds if c.name == "set_clip_fade")
    assert [a.name for a in fade.args][:3] == ["clipId", "fadeInSec", "fadeOutSec"], fade.args
    return len(cmds)


def main():
    from build_add_note_corrective import TARGET_ROWS, build_rows

    n_cmds = check_entry_parser()

    rows = build_rows()

    # ── row count ──────────────────────────────────────────────────────────────
    assert len(rows) == TARGET_ROWS, f"expected {TARGET_ROWS} rows, got {len(rows)}"
    assert 35 <= len(rows) <= 45, f"row count {len(rows)} is not ~40"

    seen_users = set()
    for i, row in enumerate(rows):
        msgs = row.get("messages")
        assert isinstance(msgs, list) and len(msgs) == 3, (i, msgs)
        roles = [m.get("role") for m in msgs]
        assert roles == ["system", "user", "assistant"], (i, roles)
        system, user, assistant = (m["content"] for m in msgs)

        # ── system prompt sanity: real catalog text, add_note present ──────────
        assert isinstance(system, str) and "add_note(" in system, i
        assert "You ARE Moshi" in system, i

        # ── user turn: non-empty, unique across the batch ───────────────────────
        assert isinstance(user, str) and user.strip(), i
        assert user not in seen_users, f"duplicate user turn at row {i}: {user!r}"
        seen_users.add(user)

        # ── assistant: valid JSON, ALL commands are add_note ────────────────────
        parsed = json.loads(assistant)
        assert parsed.get("intent") in {"ACK_GOT_IT", "ACK_WORKING", "DONE"}, (i, parsed)
        cmds = parsed.get("commands")
        assert isinstance(cmds, list) and len(cmds) >= 1, f"row {i} has no commands"
        for c in cmds:
            assert c.get("command") == "add_note", (
                f"row {i} used {c.get('command')!r}, not add_note — "
                "this is the exact r5 4-bit routing flip this dataset counters"
            )
            a = c.get("args", {})
            assert isinstance(a.get("clipId"), str) and a["clipId"], (i, a)
            assert isinstance(a.get("pitch"), (int, float)) and not isinstance(a.get("pitch"), bool), (i, a)
            assert 0 <= a["pitch"] <= 127, (i, a)
            assert isinstance(a.get("start"), (int, float)) and not isinstance(a.get("start"), bool), (i, a)
            assert a["start"] >= 0, (i, a)
            assert isinstance(a.get("length"), (int, float)) and not isinstance(a.get("length"), bool), (i, a)
            assert a["length"] > 0, (i, a)
            assert isinstance(a.get("velocity"), (int, float)) and not isinstance(a.get("velocity"), bool), (i, a)
            assert 0 <= a["velocity"] <= 127, (i, a)

    # ── never the command this dataset is specifically countering ──────────────
    for i, row in enumerate(rows):
        assert "add_drum_pattern" not in row["messages"][2]["content"], i

    # ── determinism: building twice in-process is byte-identical ───────────────
    rows_again = build_rows()
    assert json.dumps(rows) == json.dumps(rows_again), "build_rows() is not deterministic"

    print(f"build_add_note_corrective_test: ALL PASS ({len(rows)} rows, {n_cmds} catalog commands)")


if __name__ == "__main__":
    main()
