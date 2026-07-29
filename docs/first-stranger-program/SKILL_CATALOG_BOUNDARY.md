# The two skill catalogs — facts, boundary, and the guard

*Off-backlog finding, 2026-07-27. Backlog row: **FS-B1a**.*

FS-B1's lane doc closes with a constraint on its own future:

> No service package is added. A future service consumer must establish a
> generated or otherwise single-source boundary instead of creating a second
> hand-maintained catalog.

`service/skills/` landed later (#409). This note records what actually got
built, whether the constraint was violated, what the boundary is now, and where
the guard lives.

**Short version:** the constraint was *mostly honoured and never written down*.
`service/skills/` is not a second hand-maintained command catalog — it parses
`ui/src/agent/commands.ts` as ground truth. What it added is a *different kind
of artifact* (a mined retrieval corpus) that shares only the command surface
with `skills.ts`. The two real defects were that the projection was silently
**lossy**, and that the shipped mined library was **unguarded** against the
catalog it names. Both are now fixed and RED-proved.

---

## 1. The facts (step 1 deliverable)

### 1.1 The two artifacts are not the same kind of thing

| | `ui/src/agent/skills.ts` | `service/skills/library.jsonl` |
|---|---|---|
| Origin | hand-written | **mined** from `service/sft/*.jsonl` by `mine.py` (deterministic clustering, no ML) |
| Count | 8 skills | 36 skills |
| Granularity | multi-command **workflow DAGs** (`arrange_beat` = tempo + time-sig + drum grid + metronome) | 1–2 command **micro-skills** (`set-tempo`, `arm-track`) |
| Naming | `snake_case` | `kebab-case` |
| Numeric bounds | **yes** — 12 bounded numeric slots (`db` −60..+6, `value` 0..1, `bpm` 20..300, `bars` 0.25..128 …) | **none** — `schema.Slot` has no `min`/`max` field at all |
| Pre/postconditions | executable TypeScript predicates over a `Snapshot` | tagged dicts from a fixed 8-member vocabulary (`track_exists`, `bus_missing`, …) |
| Slot types | `string`/`number`/`boolean` | those plus `list<note>`, `list<string>`, `list<number>`, `list<param>` |
| Extra fields | — | `provenance` (corpus row refs), `triggers` (IDF-weighted retrieval bag), `source`, `default` |
| Executed by | `skillHarness.ts` → `runAgentBatch` → MoshOps, **in the shipped app** | `router.py`, offline. `service/skills/README.md`: "not wired into the app" |
| Purpose | run a producer's intent as one undoable batch | deterministic lexical retrieval + slot filling over demonstration data |

### 1.2 Overlap is far smaller than the raw counts suggest

- **Skill-name overlap: 0.** Exact: none. After normalising `-`→`_`: still none.
- **Command overlap: 5 of 40 distinct commands (12.5%).**
  Shared: `set_plugin_param`, `set_tempo`, `set_time_signature`,
  `set_track_mute`, `set_track_volume`.
  TS-only (15): `accept_render`, `add_drum_pattern`, `bypass_plugin`,
  `create_lyric_sheet`, `create_render_layer`, `detect_clip_bpm`,
  `load_plugin`, `rename_clip`, `render_layer`, `set_lyric_constraint`,
  `set_lyric_line`, `set_metronome`, `set_render_param`,
  `set_track_automation_mode`, `stretch_clip`.
  Python-only (20): `add_note`, `add_send`, `arm_track`, `assign_sample`,
  `create_bus`, `keep_take`, `list_takes`, `load_builtin`, `load_drum_kit`,
  `remove_send`, `rename_track`, `set_current_take`, `set_input_monitor`,
  `set_note`, `set_send_level`, `set_track_pan`, `set_track_solo`,
  `set_track_type`, `set_transport`, `stop_recording`.
- **Contradictory slot types for a shared command: none.** Both sides bind the
  same argument names with the same primitive types, because both validate
  against the same catalog.
- **Contradictory bounds: none, but only because one side has none.** For every
  shared command the TS side clamps and the Python side does not:

  | Command · arg | `skills.ts` bound | mined library |
  |---|---|---|
  | `set_track_volume.db` | −60 … +6 | number, no bound (`default: -3`) |
  | `set_plugin_param.value` | 0 … 1 | number, no bound (`default: 0.72`) |
  | `set_tempo.bpm` | 20 … 300 | number, no bound (`default: 90`) |
  | `set_time_signature.numerator` / `.denominator` | 1 … 32 | number, no bound (`default: 3` / `4`) |
  | `set_track_mute.mute` | optional boolean slot | bound to the literal `true` (no slot) |

  This is an asymmetry, not a disagreement — the mined side never claims a
  bound, so nothing can drift out of agreement with the TS one. It *is* a real
  gap if the router is ever wired into the live loop; see §4.

### 1.3 The command catalog was already single-sourced — but lossily

`service/skills/moshops_catalog.py` does **not** hand-copy commands. It parses
`ui/src/agent/commands.ts` with a bracket/string-aware scanner and raises if the
file is absent. Comparing its output field-for-field against the real
`AGENT_COMMANDS`:

- 124 commands on both sides, **same names, same order**.
- **Every argument name, type, and requiredness matched — 124/124.** No drift.
- **2 of 124 command *descriptions* were silently truncated.** `_DESC_RE` used a
  non-greedy `".*?"`, which stops at the first quote even when backslash-escaped:

  | Command | TS `desc` | parsed `desc` (before the fix) |
  |---|---|---|
  | `compile_render` | `Compile a loose instruction ("make it lo-fi", "as a violin") into a validated generative render…` | `Compile a loose instruction (\` |
  | `add_drum_pattern` | `…short lanes tile ("x." = 8th hats)` | `…short lanes tile (\` |

  Neither command is in the mined library, so the blast radius today was zero —
  but `desc` is what `mine.py` turns into skill descriptions and retrieval
  triggers, so the next mining run over either command would have baked a
  truncated description into `library.jsonl`. **A parser that drops data is a
  second catalog wearing a projection's clothes.** Fixed with an escape-aware
  pattern; `library.jsonl` re-mines byte-identical after the fix.

### 1.4 The shipped mined library was unguarded

`library.jsonl` is mined once and committed. Nothing re-validated it against
the catalog — `router_test.py` says so explicitly: it uses corpus fixtures,
"not the shipped library.jsonl". A renamed argument in `commands.ts` would rot
the shipped library in place and the router would emit invalid commands with a
fully green suite. (Checked by hand at the time of writing: 0 problems. That was
currency, not a guard.)

### 1.5 Two corrections to the framing of this task

- **`fs-b1.md` has no STATUS block.** The finding was not recorded there. This
  file and the FS-B1a backlog row are now the record; `fs-b1.md` links here.
- **The FS-B1 *backlog row* lists `service/skills/` in its own `files` array.**
  The lane doc narrowed that to "no service package"; #409 built to the backlog
  row's original scope. So this is under-specification between two documents
  that both claimed authority, not a developer ignoring a written constraint.

---

## 2. The decision (step 2)

**Keep both. Do not merge, and do not generate one from the other. Single-source
the one thing they actually share — the command surface — and guard that seam
from both sides.**

Weighed and rejected:

- **Generate the Python catalog from the TypeScript one (or vice versa).**
  Rejected: there is nothing to generate. They share no skill, and the fields
  that would have to be generated do not exist on the other side in either
  direction — TS skills carry executable predicate *functions* and numeric
  bounds that JSON cannot hold; mined skills carry `provenance`, `triggers`,
  `list<…>` slot types, and `repeat_over`/`emit_if`, none of which the TS schema
  models. Generation would mean inventing the missing halves, which is exactly
  the hand-maintenance this is meant to avoid.
- **Make one a pure consumer of the other.** Rejected in both directions.
  If the mined library consumed `SKILL_CATALOG`, mining stops being mining —
  its whole value is that every field is provenance-derived and never
  hand-invented. If `SKILL_CATALOG` consumed the mined library, the shipped app
  would execute unbounded, unclamped, statistically-derived templates with no
  postcondition; the ASTD-style bounds in `skills.ts` are a safety property, not
  decoration.
- **Merge into one catalog.** Rejected: it would force one of the two failures
  above, and it would put a 36-entry offline retrieval corpus into the shipped
  bundle for no user-facing gain.

What *is* genuinely shared is the MoshOps command surface, and there the
single-source rule applies without compromise: `ui/src/agent/commands.ts` is the
sole authority, `moshops_catalog.py` is a **projection** of it, and the mined
library is **downstream** of that projection. FS-B1's constraint is satisfied by
making that projection provably faithful — not by collapsing two different
artifacts into one.

The boundary in one line:

```text
ui/src/agent/commands.ts            (sole authority: 124 commands, arg names/types)
  ├── ui/src/agent/skills.ts        → executable workflow DAGs   → runAgentBatch → MoshOps.cpp
  └── moshops_catalog.py (parse)    → mined library.jsonl        → router.py (offline)
```

---

## 3. The guard (step 3)

Two files, deliberately split across the two gate lanes:

| Guard | Where | Fires when |
|---|---|---|
| Projection is faithful field-for-field; mined library is valid against the real `AGENT_COMMAND_MAP`; skill-name namespaces are disjoint | `ui/src/agent/skillCatalogBoundary.test.ts` (vitest, 12 tests) | **any** PR — vitest always runs |
| Parser fidelity on escaped quotes; mined library valid against `load_catalog()` | `service/skills/contract_test.py` (pytest, 12 tests) | PRs touching `service/` |

**The split is load-bearing, not redundancy for its own sake.** The cheap gate's
Python suite is PATH-SCOPED — `run_py_tests` in `scripts/auto-loop/gate.sh`
returns early unless the diff touches `relay/` or `service/`. A `ui/`-only PR
that renames a command argument would never run the pytest half. So the guard
that must fire on a `ui/` change lives in vitest, and it reaches the Python side
by spawning `python3` (a missing interpreter is a hard failure, never a skip — a
skipped parity check looks exactly like a passing one).

### RED-proof

Every guard family was proved to fail, then the plant removed and green
reconfirmed. No `SABOTAGE` marker survives; `git status` was verified clean
after each restore.

| Planted divergence | Went red |
|---|---|
| A · rename `set_tempo`'s `bpm` arg in `commands.ts` | vitest ×2 (`arg is declared`, `binds required`) + pytest ×2 |
| B · revert `_DESC_RE` to the escape-unaware pattern | vitest ×2 (`desc without truncation`, `field for field`) + pytest ×4 |
| C · rename a mined skill onto a TS skill name | vitest ×1 (`namespaces are disjoint`) |
| D · point a mined skill at a non-existent command | vitest ×1 + pytest ×1 |
| E · bad literal type in a mined template (`mute: "yes"`) | vitest ×1 + pytest ×1 |

Each suite also carries an explicit non-vacuity assertion (catalog ≥ 100
commands, library ≥ 30 skills, ≥ 1 literal argument actually type-checked), so
an empty or unreadable input fails instead of passing trivially.

---

## 4. Left open (deliberately)

- **The mined library has no numeric bounds.** Harmless while `router.py` is
  offline scaffolding. If the router is ever wired into the live agent loop it
  will emit unclamped values, and it will need either bounds in `schema.Slot` or
  a shared bounds table sourced from `skills.ts`. That is a design change with a
  real decision in it, not a guard — it belongs in the lane that does the
  wiring, not here.
- **`validate_command` in `moshops_catalog.py` mirrors `validateCommand` in
  `commands.ts` by hand** (~10 lines, both trivial). The parity test covers the
  *data*, not this function's behaviour. Worth folding into the parity test if
  either implementation ever grows past primitive-type checks.
- **`desc` escape handling is `\<quote>` and `\\` only.** No `\n`/`\t`/`\uXXXX`
  appear in `commands.ts` today, and the parity test would go red the moment one
  did — which is the intended failure mode.
