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


def main():
    from build_add_note_corrective import TARGET_ROWS, build_rows

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

    print(f"build_add_note_corrective_test: ALL PASS ({len(rows)} rows)")


if __name__ == "__main__":
    main()
