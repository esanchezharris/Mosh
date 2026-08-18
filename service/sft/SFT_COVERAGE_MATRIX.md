# SFT coverage matrix — training-row exposure per agent command

*How many `s2-mix-v5` training rows exercise each of the current
`AGENT_COMMANDS` (`ui/src/agent/commands.ts`) — the same command set the
in-app agent, `gepa`, and every eval surface use. This is training-row
**exposure**, not eval-floor **pass/fail**; see
[`EVAL_RUNBOOK.md`](EVAL_RUNBOOK.md) and
[`GATE_READ_a3b-r5-cuda.md`](GATE_READ_a3b-r5-cuda.md) for the actual gate
numbers. A command can have zero training rows and still be handled fine at
inference (base-model generalization), or have hundreds of rows and still
miss its eval floor (a routing/format defect, not a coverage gap) — the two
signals are deliberately kept separate here.*

## Data source (found, not synthesized)

`service/sft/.sft-data/` is gitignored and absent from every worktree of this
repo (`.gitignore:64`) — there is no `s2-mix-v5/train.jsonl` committed
anywhere. This matrix was built from a file found on this machine, **verified
byte-for-byte identical to the registered training mix** by hash, not assumed:

```
$ shasum -a 256 ~/Mosh/service/sft/.sft-data/s2-mix-v5-prep/train.jsonl
3c4e2e8b2ecc3562404fb824aa0b7dd131bd908e936c946cc8d3507adbf071eb
```

This matches the `s2-mix-v5` train sha registered in
`docs/bench/PROGRAM_STAGE1_2026-07.md` §P9 and in
`GATE_READ_a3b-r5-cuda.md` line 16 (`3c4e2e8b2ecc3562…`) — the exact file
that trained `a3b-r5-cuda`, despite living in a directory still named
`s2-mix-v5-prep` (its `manifest.json` shows the prep dir's `assist_demo_rows`
count is 105 = the 15 assist rows + 90 drum-sampler-batch rows §P9 describes
as folded together into `r5_train_additions.jsonl`; `12,889 (v4) + 105 = 12,994`
matches the registered row count exactly, and `valid.jsonl`'s sha
`9047ab96fd7e8f7f…` matches v4's valid sha verbatim, as documented — "valid =
v4's 1,650 VERBATIM"). Row/valid counts: **12,994 train / 1,650 valid.**

This file is **outside this ticket's worktree** (found at
`~/Mosh/service/sft/.sft-data/s2-mix-v5-prep/train.jsonl`, a different local
checkout of the same repo) — it is not committed here and this doc does not
change that; it is cited only as the source of the counts below.

## Method (reproducible)

Each training row is `{"messages": [system, user, assistant]}`; the assistant
message is `{"intent": …, "commands": [{"command": …, "args": …}, …]}`. For
every row, every distinct `command` name appearing in its `commands` array is
counted once toward that command's **row count**; every individual command
object (a row can carry the same command N times — e.g. `add_note` populating
a whole pattern) is counted toward its **occurrence count**. Rows with an
empty `commands` array (a HUH/defer gold row) count toward neither.

```python
import json
from collections import Counter

row_counter, occ_counter = Counter(), Counter()
with open("s2-mix-v5-prep/train.jsonl") as f:
    for line in f:
        row = json.loads(line)
        reply = json.loads(row["messages"][-1]["content"])
        seen = set()
        for c in reply.get("commands") or []:
            name = c.get("command")
            if not name:
                continue
            occ_counter[name] += 1
            seen.add(name)
        for name in seen:
            row_counter[name] += 1
```

Cross-referenced against the command list extracted live from
`ui/src/agent/commands.ts` (`AGENT_COMMANDS`, matched on
`command:\s*"([a-z_]+)"`) — **88 commands** as of this doc's HEAD
(`0c7f12e7`, 2026-07-17). §P2 of `PROGRAM_STAGE1_2026-07.md` enumerated **78**
commands on 2026-07-03, the coverage-target registration date — 10 commands
below post-date that enumeration and were never targeted by any coverage
synthesis round by construction, not by omission.

## Coverage table (68 of 88 commands have ≥1 row)

Sorted by row count, descending. `rows` = distinct training rows mentioning
the command at least once; `occ` = total command invocations (≥ rows when a
row repeats the command, e.g. note population).

| command | rows | occ |
|---|---:|---:|
| add_note | 402 | 3192 |
| set_tempo | 401 | 401 |
| set_time_signature | 400 | 400 |
| add_midi_clip | 400 | 400 |
| split_clip | 366 | 366 |
| move_clip | 355 | 371 |
| set_track_type | 325 | 325 |
| trim_clip | 318 | 318 |
| duplicate_clip | 304 | 304 |
| remove_note | 300 | 300 |
| load_drum_kit | 294 | 294 |
| build_skeleton_from_clip | 292 | 292 |
| create_render_layer | 284 | 284 |
| save | 268 | 268 |
| arm_track | 260 | 300 |
| set_input_monitor | 256 | 256 |
| move_section | 252 | 252 |
| set_master_volume | 252 | 252 |
| set_clip_gain | 248 | 248 |
| set_key | 248 | 248 |
| add_test_tone_clip | 240 | 240 |
| redo | 236 | 236 |
| undo | 236 | 236 |
| rename_clip | 236 | 236 |
| remove_section | 228 | 228 |
| set_master_pan | 228 | 228 |
| set_transport | 228 | 232 |
| open_plugin_editor | 224 | 224 |
| set_track_pan | 221 | 233 |
| create_section | 220 | 220 |
| set_metronome | 220 | 220 |
| set_track_volume | 217 | 217 |
| remove_track | 216 | 216 |
| set_clip_mute | 216 | 216 |
| stop_recording | 216 | 216 |
| create_annotation | 216 | 216 |
| rename_track | 213 | 213 |
| rename_section | 212 | 212 |
| create_track | 208 | 208 |
| remove_clip | 204 | 204 |
| set_track_solo | 201 | 237 |
| set_track_mute | 197 | 202 |
| render_layer | 196 | 196 |
| set_render_param | 172 | 172 |
| freeze_layer | 168 | 168 |
| reject_render | 156 | 156 |
| create_lyric_sheet | 152 | 152 |
| remove_render_layer | 152 | 152 |
| suggest_next_line | 144 | 144 |
| remove_lyric_line | 120 | 120 |
| bypass_plugin | 116 | 116 |
| bounce_layer_to_clip | 116 | 116 |
| regenerate_lyric | 88 | 88 |
| bypass_layer | 80 | 80 |
| assign_sample | 72 | 72 |
| set_plugin_param | 71 | 74 |
| fill_lyric_gap | 68 | 68 |
| import_clip | 68 | 68 |
| load_builtin | 68 | 68 |
| complete_lyrics | 52 | 52 |
| accept_render | 48 | 48 |
| set_lyric_line | 48 | 64 |
| analyze_lyrics | 48 | 48 |
| remove_plugin | 40 | 40 |
| sketch_beatbox | 40 | 40 |
| set_note | 20 | 36 |
| quantize_notes | 12 | 12 |
| set_lyric_constraint | 12 | 12 |

Row-count ceilings around 400 are the `s2-mix-v3` rebalance's **flat
per-command cap** (`rebalanceSelect`, cap 400, `PROGRAM_STAGE1_2026-07.md`
§P7.2) — `add_note`/`set_tempo`/`set_time_signature`/`add_midi_clip` sit right
at/near it, exactly as documented ("head 3 + add_note at 400 each"). 250 of
the 12,994 rows are HUH/defer gold rows (no `commands`), matching the
registered "HUH re-cap 250 rows" from the same section.

## Zero-coverage commands (20 of 88)

None of these 20 commands appear in a single `s2-mix-v5` training row. They
fall into three distinct, previously-documented buckets — conflating them
would misdiagnose "add training data" as the fix for commands that are
structurally unsynthesizable or simply postdate the freeze:

### A. Structural named-misses (9) — entity/id invisible in the serving snapshot, or harness-blocked

Documented at `PROGRAM_STAGE1_2026-07.md`, WP-4/5 ⛳ coverage FINAL row
(2026-07-03): "9 named misses with causes: 3 annotation edits + reorder_plugin
(entity/slot ids invisible in the serving snapshot), 3 take commands (no
headless take creation), load_plugin (scanned ids unknowable), get_rhymes
(HARNESS: synchronous service query fails in the grade replay)."

| command | added | cause |
|---|---|---|
| `edit_annotation` | 2026-06-21 | annotationId not in the serving snapshot |
| `move_annotation` | 2026-06-21 | annotationId not in the serving snapshot |
| `remove_annotation` | 2026-06-21 | annotationId not in the serving snapshot |
| `reorder_plugin` | 2026-06-17 | plugin chain slot indices not in the serving snapshot |
| `list_takes` | 2026-06-17 | no headless way to create take lanes |
| `set_current_take` | 2026-06-17 | no headless way to create take lanes |
| `keep_take` | 2026-06-17 | no headless way to create take lanes |
| `load_plugin` | 2026-06-17 | scanned-plugin ids unknowable outside a live scan |
| `get_rhymes` | 2026-06-27 | synchronous service query fails in the grade replay (proven correct via an engine-only probe with perfect args) |

### B. Documented model-behavior partial-miss (1)

| command | added | cause |
|---|---|---|
| `accept_lyric_proposal` | 2026-06-27 | 118 synthesis rows were attempted; **0 kept** — "the model never acts on invisible proposals even when the request asserts them" (`PROGRAM_STAGE1_2026-07.md` WP-4/5 FINAL row) |

### C. Added after the coverage-target enumeration — never targeted by any round (10)

§P2's 78-command coverage target was registered 2026-07-03. These commands
did not exist yet. For the five 2026-07-10 entries specifically: the
`s2-mix-v5-prep` manifest was written `2026-07-10T06:06:55Z` (UTC) =
2026-07-09 23:06 PDT, and `git log --format=%aI` shows `create_bus` /
`add_send` / `set_send_level` / `remove_send` landed 2026-07-10T18:52:27-07:00
and `add_drum_pattern` 2026-07-10T19:15:57-07:00 — both roughly **20 hours
after** the mix was written. All five confirmed post-date the frozen training
data, not merely same-day. None of the 10 were ever the subject of a
synthesis/calibration round; zero rows is expected, not a regression.

| command | added |
|---|---|
| `compile_render` | 2026-07-04 |
| `reset_render_layer` | 2026-07-04 |
| `assert_lyric_line` | 2026-07-09 |
| `create_bus` | 2026-07-10 |
| `add_send` | 2026-07-10 |
| `set_send_level` | 2026-07-10 |
| `remove_send` | 2026-07-10 |
| `add_drum_pattern` | 2026-07-10 |
| `stretch_clip` | 2026-07-17 |
| `detect_clip_bpm` | 2026-07-17 |

(Dates from `git log -S'command: "<name>"' -- ui/src/agent/commands.ts`,
first commit that introduced the entry, on this branch's history.)

## What this means for r6

`s2-mix-v5` is carried forward **verbatim** into the r6 plan
([`R6_TRAINING_PLAN.md`](R6_TRAINING_PLAN.md)) — none of these 20 gaps are a
new problem r6 is trying to fix, and the LOCAL_SERVE_READ regression r6 *is*
targeting (`add_note` under a 4-bit MLX serve) is a **covered** command (402
rows) whose training-row count was never the issue. If a future cycle wants
to close bucket C (the 10 newest commands), that is a fresh synthesis round
on top of whatever mix r6 lands on — out of scope for this document.

**Addendum (post-r6 prep, not part of the r6 registration above):** an
r5 novice-jam bench found `add_drum_pattern` (bucket C, zero rows here) as a
live miss — exactly the "add training data" fix this section says bucket C
needs once a future cycle takes it up. That candidate data now exists as a
standalone, unmerged increment: `r7_coverage_demonstrations.jsonl` (119
rows, validated by `validate_sft_rows.py`), documented in
`R6_COVERAGE_PREP_NOTE.md` / `RUN_NEXT.md`. It is NOT folded into `s2-mix-v5`
and does not change any count in this table — this note exists so the next
reader of this matrix doesn't have to rediscover that prep work already
started.
