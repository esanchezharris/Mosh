# FS-B1 — Skill schema, mock harness, and contract test

**Lane:** B (Brain) · **Spec:** `docs/first-stranger-program/SPEC.md` §0,
§1.9–§1.10, §7 B1 · **Backlog class:** `cheap` · **Route:** `safe`.

> ## STATUS: GAP-CLOSED — this shipped, and the backlog row was stale
>
> Everything below is written in the present tense because it describes **merged code**,
> not a plan. FS-B1 landed as **PR #324** ("FS-B1: add typed skill harness and command
> contract") and has since been extended twice — **#371** (`AG-SK1`, workflow-DAG skills)
> and **#419** (`AG-KB-AUTO`, KB + skill for the automation & clip-ops commands). The
> backlog nonetheless still said `ready`, which is how a session gets sent to rebuild it.
> Caught by SPEC §0's gap-verify on 2026-07-27; row flipped to `gap-closed`.
>
> Verified on the current tree, not inferred from file names — the lane's own required
> battery:
>
> ```
> skills.test.ts · skillHarness.test.ts · skillHarness.failure.test.ts
> commands.contract.test.ts · executor.test.ts · executor.batch-boundary.test.ts
>   → 6 files, 206 tests, all passing
> ```
>
> `SKILL_CATALOG` now carries **9** skills (`set_track_level` — the reference skill this
> doc describes — plus `arrange_beat`, `build_drum_pattern`, `add_vocal_with_lyrics`,
> `reimagine_clip`, `host_plugin` and others), so the acceptance's "one reference skill
> passes end-to-end" is comfortably exceeded.
>
> The `codex/stranger-fs-b1` branch (`31aa48b8`) is **superseded** — `main` is 734 lines
> of `skills.ts` ahead of it. Delete it rather than merging it.
>
> **One thing this lane explicitly warned about has since happened.** See
> "Files in scope" below: *"A future service consumer must establish a generated or
> otherwise single-source boundary instead of creating a second hand-maintained
> catalog."* `service/skills/` now exists — 3,561 lines with its own `schema.py`,
> `moshops_catalog.py`, a mined `library.jsonl` of 36 skills and a deterministic
> `router.py`. That is a second hand-maintained catalog. Reconciling the two is real,
> currently-untracked work; it is not FS-B1 re-opened.

## Purpose

FS-B1 provides the script-independent substrate for later Brain work:

- a readonly skill schema with a name, natural-language description, typed
  slots, bounded declarative MoshOps templates, preconditions, and
  mock-assertable postconditions;
- a harness that validates and executes one reference skill through the
  existing agent/MoshOps batch seam; and
- a durable contract that connects every skill command and argument to the
  TypeScript command catalog and real C++ dispatch surface.

The O2-derived skill set belongs to FS-B2. FS-B1 contains one reference skill
that edits an artifact already in the session and does not create musical
material.

## Implementation

### Schema and catalog

`ui/src/agent/skills.ts` is the single source of truth. It defines:

- `SkillSlot` variants for string, finite number, and boolean values;
- required/optional slots with string enums or numeric bounds;
- literal or named-slot template values;
- fixed command nodes and bounded `if_present` branches;
- pure precondition and postcondition predicates returning structured results;
- a readonly `SKILL_CATALOG`.

Slot validation rejects missing required slots, unknown slots, wrong primitive
types, non-finite numbers, bounds violations, and enum violations before a
snapshot or mutation call. Values are never coerced.

### Reference skill

`set_track_level` has these slots:

| Slot | Type | Required | Constraint |
|---|---|---:|---|
| `trackId` | string | yes | existing track; group mute is refused |
| `db` | number | yes | `-60..+6` dB |
| `mute` | boolean | no | presence controls the branch |

The template always emits `set_track_volume({trackId, db})`. It emits
`set_track_mute({trackId, mute})` only inside `if_present("mute")`, so
`mute:false` is distinct from an omitted value. A group track may use the
volume-only template, but a group mute is rejected before execution because
native `set_track_mute` does not accept groups. The postcondition compares
narrowed numeric and boolean values without coercion and requires an omitted
mute slot to preserve the prior state.

### Harness and existing seams

`ui/src/agent/skillHarness.ts` performs this fixed sequence:

1. validate raw slots;
2. read the before snapshot and evaluate the precondition;
3. expand the bounded template;
4. preflight every command with the existing `validateCommand`;
5. execute once through the existing `runAgentBatch` seam;
6. require exactly one indexed, command-matched result per expanded call;
7. read the after snapshot and evaluate the postcondition.

`ui/src/agent/executor.ts` remains the only batch executor. Its change entries
now carry the original call index and command identity. The destructive-command
screen, `batch_begin`/`batch_end` grouping, MoshOps validation, store seam, and
single undo path remain in place. Resolved failure envelopes from either batch
boundary reject execution; commands never run after a failed begin. A resolved
failed end carries the exact applied-command count to the harness, which attempts
the existing undo seam and reports rollback only when undo confirms it.

### Failure and rollback semantics

The harness makes only these rollback claims:

- Validation, precondition, template, and preflight failures make no mutation
  call and return `rolledBack:false`.
- A resolved batch that reports a partial failure, malformed per-call results,
  a resolved failed `batch_end`, or a failed postcondition attempts the existing
  `undo` seam when at least one mutation was reported.
- `rolledBack:true` is returned only when the undo result explicitly reports
  that an undo occurred. A rejected or no-op undo returns `rolledBack:false`.
- A rejected batch promise has an ambiguous transport outcome. It returns
  `rolledBack:false`, records that mutation state is unknown, and does not issue
  a blind undo that could affect unrelated prior work.

Deterministic rollback after ambiguous transport loss requires an engine-owned
batch abort/status contract. That is an owner-routed FS-B2 prerequisite, not a
claim or hidden implementation in FS-B1.

### Durable command contract

`ui/src/agent/commands.contract.test.ts` uses one exhaustive recursive walker.
For every catalogued template branch it verifies:

- skill and slot names are unique and non-empty;
- every conditional names a declared slot and has a non-empty body;
- optional slot references are guarded by an enclosing `if_present` branch;
- nested conditionals carry their presence guarantees recursively;
- every command exists in `AGENT_COMMAND_MAP` and the parsed MoshOps dispatch;
- every required command argument is bound;
- bound argument names and primitive types match the command catalog;
- the existing C++ parser proves each catalog argument is read by its handler.

The resulting chain is:

```text
SKILL_CATALOG template
  → AGENT_COMMANDS names, arguments, and types
  → MoshOps.cpp dispatch and handler reads
```

## Acceptance evidence

| Acceptance clause | Repository proof |
|---|---|
| Name, description, typed slots, MoshOps template, precondition, postcondition | `skills.ts` plus static contract tests |
| Schema-validated slot filling | invalid-fill matrix with zero execution and unchanged snapshots |
| Reference skill against engine mock | happy-path, optional-branch, postcondition, and undo-group tests |
| Catalog tied to real command surface | exhaustive template walker plus existing MoshOps parser |
| Truthful failure behavior | transport rejection, partial failure, unconfirmed undo, and incomplete-result tests |

Required verification commands:

```sh
cd ui
npm test -- --run \
  src/agent/skillHarness.test.ts \
  src/agent/skillHarness.failure.test.ts \
  src/agent/commands.contract.test.ts \
  src/agent/executor.test.ts \
  src/agent/executor.batch-boundary.test.ts \
  --no-cache
npm run typecheck

cd ..
scripts/auto-loop/gate.sh cheap <FS-B1-worktree> \
  <target-base-ref>
```

The authoritative cheap-gate result and exact committed SHA belong in the lane
PR. The repository-level native pre-merge battery remains binding on the owner
who merges.

## Files in scope

| Path | Role |
|---|---|
| `ui/src/agent/skills.ts` | schema, strict validation, reference catalog |
| `ui/src/agent/skillHarness.ts` | ordered runner and rollback policy |
| `ui/src/agent/skillHarnessResult.ts` | exact per-call result accounting |
| `ui/src/agent/skillHarness.test.ts` | happy path, validation, branches, preconditions |
| `ui/src/agent/skillHarness.failure.test.ts` | failure, rollback, transport, undo grouping |
| `ui/src/agent/executor.batch-boundary.test.ts` | resolved batch-boundary failure handling |
| `ui/src/agent/commands.contract.test.ts` | static skill-to-command-to-C++ contract |
| `ui/src/agent/executor.ts` | indexed result identity and confirmed undo result |
| `docs/first-stranger-program/lanes/fs-b1.md` | durable lane facts and evidence map |

No service package is added. A future service consumer must establish a
generated or otherwise single-source boundary instead of creating a second
hand-maintained catalog.

## §0 constraints and non-goals

- This worktree and branch contain FS-B1 only.
- Every reference-skill mutation goes through the existing MoshOps-backed batch
  executor; tests reset the mock only during test setup.
- No `src/**`, state/event/snapshot schema, CMake, relay, auth, packaging, or
  native command-handler file is changed.
- No B2 skill set, B3 router, retrieval, proxy, or service catalog is added.
- No cache or build input is placed under `~/Documents`.
- Parked material and loop/gate/rulebook files remain untouched.

The lane remains `safe` because its product changes are under `ui/**` and its
only documentation change is this lane plan. A native-command repair, engine
batch-abort contract, or any other compiled change must leave this lane and use
an owner route.
