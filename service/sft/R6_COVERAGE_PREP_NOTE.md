# r6-sft-data-pass — conflict found, scope adjusted, prep delivered

*Status: informational note, not a pre-registration. Read this before touching
`r7_coverage_demonstrations.jsonl` or folding it into anything.*

## The conflict (read first)

The task that produced this file asked for "the targeted SFT data pass for the
r6 training run" — new drum/lyric/ambiguity coverage rows, to be folded into
whatever r6 trains on. **That is incompatible with the r6 plan as written.**

[`R6_TRAINING_PLAN.md`](R6_TRAINING_PLAN.md) §2.1:

> "r6 changes **base precision only**, not the mix... `s2-mix-v5`... is
> carried forward unmodified. Rationale: the LOCAL_SERVE_READ diagnosis is
> explicit that the `add_note` regression is a **precision/architecture**
> defect... not a data-coverage gap... Adding more `add_note` rows would not
> address a defect that reproduces on the BASE model."

§4.5, even more directly, about exactly this class of change:

> "Folding new corrective rows for any of the 20 [zero-coverage commands]
> into the mix this cycle would reopen the §2.2 confound with a **fourth**
> simultaneous change — out of scope here by design, not an oversight."

[`R6_FREEZE_MEMO.md`](R6_FREEZE_MEMO.md) §3 freezes `s2-mix-v5`'s train/valid
shas verbatim, and §6.5: "This memo does not add a corrective data batch...
any new corrective rows are a **new** cycle's pre-registration, not a silent
edit to this one." [`SFT_COVERAGE_MATRIX.md`](SFT_COVERAGE_MATRIX.md)'s own
closing line: "If a future cycle wants to close bucket C [zero-coverage,
post-freeze commands — **`add_drum_pattern` is in this bucket**], that is a
fresh synthesis round on top of whatever mix r6 lands on — out of scope for
this document."

r6 is a **precision-isolation experiment**: 4-bit-base training vs r5's bf16,
holding the data mix, LoRA scope, and rank exactly as constant as the tooling
allows (§2.2's "three-way confound"). Injecting new rows this cycle — even
well-intentioned, even correctly targeting a real gap — would be a **fourth**
simultaneous change, on top of the three §2.2 already names, in a program
whose explicit discipline (§P1–§P9, cited throughout) is "nothing moves after
a pre-registration is committed" and "one clean read, no retry."

**Per the task's own ground rule 1 ("if the freeze memo forbids what this
task asks, STOP and report the conflict instead of overriding it"): r6 itself
is untouched by this work.** `R6_TRAINING_PLAN.md`, `R6_FREEZE_MEMO.md`, and
`s2-mix-v5` are not edited by anything in this pass.

## What was built instead

The repo has a precedent for exactly this situation: **"R5 prep while r4
runs"** (`README.md`) — `prepare_r5_prep.py` built a candidate next-cycle
dataset (`s2-mix-v5-prep`) without touching the live `r4`/`s2-mix-v4` run,
gated by an explicit audit (`audit_r4_target.py`) proving it hadn't drifted
from the frozen target. This pass follows the same shape for r6:

- **New standalone increment**, not a merge into any live mix:
  [`r7_coverage_demonstrations.jsonl`](r7_coverage_demonstrations.jsonl) — 119
  rows, chat-JSONL (`{messages:[system,user,assistant]}`), same shape
  `assist_demonstrations.jsonl`/`r5_train_additions.jsonl`/
  `add_note_corrective.jsonl` already use and are already committed
  standalone in this same directory.
- **Manifest**: [`r7_coverage_demonstrations.manifest.json`](r7_coverage_demonstrations.manifest.json)
  — sha256, row count, per-domain breakdown, provenance.
- **Generator**: [`build_r7_coverage_sft.py`](build_r7_coverage_sft.py) — pure
  Python, deterministic (no LLM calls, no randomness), hard-fails on any
  invalid row rather than silently dropping it.
- **Validator**: [`validate_sft_rows.py`](validate_sft_rows.py) — checks every
  row against the REAL command catalog (`ui/src/agent/commands.ts`, parsed
  fresh, not hand-copied), the REAL `add_drum_pattern` pattern-DSL grammar
  (ported from `ui/src/ui/drumPatternUtil.ts` in
  [`lib_drum_pattern.py`](lib_drum_pattern.py) and cross-checked against that
  file's own golden vector), the reply contract (`INTENTS`, HUH-defer-is-empty
  per `ui/src/sft/negatives.ts`), real-id-only discipline, and the two dosage
  rules named in the task (no duplicate command+args in one reply; no
  unasked `save`).
- **RED-proof**: [`validate_sft_rows_test.py`](validate_sft_rows_test.py) — 16
  tests; 4 assert real examples pass, 11 each plant one specific defect class
  (invented command, invented id, missing required arg, wrong arg type, bad
  drum-pattern-DSL char, non-tiling drum-pattern lane, commands-inside-a-defer,
  duplicate command, unasked save, invalid intent, malformed JSON) and assert
  the validator rejects it — **not vacuous**: while authoring the "GREEN"
  fixtures, the validator caught a real hand-typo (a 15-character drum-pattern
  lane string that doesn't divide 16) before this note was even written; that
  failure and its fix are visible in this branch's history.
- **Drift detector**: [`validate_system_prompt_drift.py`](validate_system_prompt_drift.py)
  — see below.

Domain breakdown (119 rows total):

| domain | rows | targets |
|---|---:|---|
| drum: beat from nothing (single `add_drum_pattern`, no track/clip id) | 20 | miss #1 |
| drum: add onto an existing drum clip (`clipId`, per-lane replace) | 14 | miss #1 |
| drum: track-only ask (no pattern yet — `create_track` alone is correct here) | 5 | miss #1 (the "when NOT to do more" half) |
| drum: kit swap on an existing drum track | 5 | miss #1 |
| contrast: melodic/bass asks that must NOT touch any drum command | 12 | miss #1 (negative space) |
| lyric: sheet + immediate line follow-through | 14 | miss #2 |
| lyric: exact-text opening-line placement | 10 | miss #2 |
| lyric: full follow-through (sheet + constraint + 2 lines) | 8 | miss #2 |
| lyric: sheet-only, args carried directly on `create_lyric_sheet` | 5 | miss #2 (minimal-command variant) |
| ambiguity: defer-EMPTY on vague/taste-only asks | 12 | miss #3 |
| near-miss contrast: concrete-sounding asks that SHOULD act | 8 | miss #3 (negative space) |
| dosage: `save` asked-vs-not-asked contrast pairs | 6 | "never save unasked" |

## Why `add_drum_pattern` specifically explains bench miss #1

[`SFT_COVERAGE_MATRIX.md`](SFT_COVERAGE_MATRIX.md)'s "Bucket C" table lists
`add_drum_pattern` as added 2026-07-10, ~20 hours **after** `s2-mix-v5` was
written — **zero training rows, confirmed, not a regression**. A model that
has never seen this command demonstrated is exactly what would fall back to
`create_track` alone, or repeat commands it *has* seen heavy exposure to
(`add_note` has 402 rows), or misapply `load_drum_kit` (294 rows, well
covered, but for the wrong situation) — which is the precise failure
signature the novice-jam bench recorded. This is not a new theory; it's this
repo's own coverage matrix confirming the bench's finding.

## Prompt-shape drift found (ground rule 2)

Every row's `system` field is the exact, byte-identical string already
committed in `assist_demonstrations.jsonl` row 0 (verified identical across
all 35 of that file's rows) — a real `buildSystemPrompt(DEFAULT_RULES,
fixture_snap.json)` render, not hand-approximated. Reusing it is the only way
to get a byte-real production prompt without executing TypeScript (ground
rule 5), and it's the same choice `assist_demonstrations.jsonl` itself makes
(one fixture snapshot, many asks).

**`validate_system_prompt_drift.py` proves that prompt is now STALE** relative
to the current `ui/src/agent/commands.ts` / `ui/src/agent/musicalTime.ts` HEAD:

```
$ python3 validate_system_prompt_drift.py
 - 33 command(s) in the CURRENT catalog are MISSING from the embedded system
   prompt (added to commands.ts after assist_demonstrations.jsonl was last
   regenerated): ['apply_choke', 'bounce_track', 'clear_drum_pad', ... ]
 - 2 command(s) in the embedded system prompt no longer exist in the current
   catalog (removed/renamed since regeneration): ['set_clip_fade', 'set_clip_loop']
 - MUSICAL_TIME_RULE (ui/src/agent/musicalTime.ts) is NOT present in the
   embedded system prompt's Rules block — the embedded prompt predates this
   rule's addition.
```

None of the 33 missing commands, and neither of the 2 removed ones, are
commands this pass's rows use — every command `r7_coverage_demonstrations.jsonl`
teaches (`add_drum_pattern`, `create_track`, `load_drum_kit`,
`create_lyric_sheet`, `set_lyric_constraint`, `set_lyric_line`, `add_note`,
`create_section`, `set_clip_mute`, `set_track_volume`, `save`) IS present in
the embedded catalog. So the file is internally self-consistent — but it is
**not** what a fresh serve renders today, and training on it as-is would
reproduce exactly the class of train/serve skew this program's own README
already flags for `r5_train_additions.jsonl` ("Session-render drift
(2026-07-28)" section) and for the MUSICAL_TIME_RULE addition specifically.

**Do not merge this file into a real training mix without first regenerating
the embedded system prompt.** The mechanical fix: run
`cd ui && npx tsx scripts/build_assist_sft.mts` fresh (regenerates
`assist_demonstrations.jsonl` against current HEAD), then re-run this pass's
generator pointed at the fresh row's `system` field instead of the current
stale one (a one-line change to `build_r7_coverage_sft.py`'s `SYSTEM`
constant) and re-validate. That step needs a real TS/node execution, which is
out of scope for this Python-only pass — flagged here, not silently done.

## What this is NOT

- Not a change to `R6_TRAINING_PLAN.md`, `R6_FREEZE_MEMO.md`, or
  `SFT_COVERAGE_MATRIX.md`'s registered content (all three untouched).
- Not `s2-mix-v5`, not `s2-mix-v6`, not any assembled train/valid split — this
  repo's `.sft-data/` (where those actually live) is gitignored and doesn't
  exist in this worktree (confirmed, same as `EVAL_FIXTURE_AUDIT.md` already
  found); there was nothing to append to even if it were in scope.
- Not a trained adapter. No training was run (ground rule 4).

## What a future cycle would do with this

See [`RUN_NEXT.md`](RUN_NEXT.md) for r6's own unaffected launch command, and
for the mechanical (not yet executed) steps a **separately pre-registered**
post-r6 cycle would take to fold `r7_coverage_demonstrations.jsonl` into a
candidate `s2-mix-v6`, mirroring `prepare_r5_prep.py`'s shape.
