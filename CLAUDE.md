# Mosh pre-pivot run manifest

> **General V3 repair, 2026-09-17:** [bounded workspace scope](docs/V3-WORKSPACE-SCOPE-2026-09-17.md) is a separate ordinary-UI verification pass; no new model execution.
>
> **V3 is the default shell:** the [V3 parity brief](docs/V3-PARITY-BRIEF-2026-09-17.md) gate closed and `uiShell` flipped from Pro Tools to V3 for fresh installs (owner direction 2026-09-17: presets, drop-in/generated beats, vocal recording, smooth multiplayer, native plugin suite).
>
> **Current direction, 2026-09-16:** [Direct SA3 Re-Imagine](docs/DIRECT-SA3-SCOPE-2026-09-16.md) supersedes the near-term agent and mixing-experiment priorities below. Those records are preserved and deferred, not prerequisites. Engineering safety and acceptance rules remain in force.

This is a truthful checkpoint, not an active roadmap. The selected product
baseline is origin/main through **7eb0d617** (PR #668). The annotated tag
**pre-pivot-baseline-2026-08-23** identifies the final docs-only baseline after
it lands on main and completes final verification. Do not infer a future product
direction from this snapshot.

**Post-pivot direction (owner-approved 2026-09-01):** see
[docs/POSTMORTEM-2026-09.md](docs/POSTMORTEM-2026-09.md) — the March–August
forensic postmortem, the binding **quality-loop contract** (weekly human
correction rounds with written lessons; no new label infra until the existing
holds ≥25 real labels; proxy metrics never gate musical decisions; no
re-platforming without postmortem + cooling period + owner sign-off; one genre
at a time), and the approved produce-lane direction. That contract governs all
future work in this repo.

**Pivot 2026-09-07 (owner-approved 2026-09-04; amendment signed 2026-09-05, effective
2026-09-07):** Moshi is Mosh's recording and mixing engineer first. Governing documents:
[docs/CONTRACT-AMENDMENT-2026-09-07.md](docs/CONTRACT-AMENDMENT-2026-09-07.md) (amendment and
supersession record), [docs/pivot-2026-09/CAPABILITY-AUDIT-2026-09-05.md](docs/pivot-2026-09/CAPABILITY-AUDIT-2026-09-05.md)
(current-commit audit and label census, pinned to `0da6c638`), and
[docs/pivot-2026-09/PLAN-90-DAY-2026-09-07.md](docs/pivot-2026-09/PLAN-90-DAY-2026-09-07.md).
The produce lane is parked at round 4; the weekly flywheel-lab obligation is superseded.

**Current state (2026-09-06).** Step 1 "useful edits exactly once" is delivered, audited twice,
accepted and **merged** (PR #698 → `914faf85`); its brief is a delivered record, not a live task.
The validation-first amendment
([docs/pivot-2026-09/HANDOFF-2026-09-06-VALIDATION-FIRST.md](docs/pivot-2026-09/HANDOFF-2026-09-06-VALIDATION-FIRST.md))
moves the next investment from building mix autonomy to **testing musical value on the owner's
own song**. Start at
[docs/pivot-2026-09/RECONCILIATION-2026-09-06.md](docs/pivot-2026-09/RECONCILIATION-2026-09-06.md):
it carries the current-state delta, the exact-interface feasibility matrix, the stamped census
(14 counted / 0 mixing, against a gate of 25), the recorded conflicts, and the single next task —
[docs/pivot-2026-09/BRIEF-REHEARSAL-SONGA-2026-09-06.md](docs/pivot-2026-09/BRIEF-REHEARSAL-SONGA-2026-09-06.md).
The frozen Song A experiment is [MIX-PACKAGE-V0.md](docs/pivot-2026-09/MIX-PACKAGE-V0.md) §7.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the code map,
[docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for the selected/archived
disposition, and [docs/FEATURE_AUDIT.md](docs/FEATURE_AUDIT.md) for the
generated conformance scoreboard.

## Engineering invariants

- **One mutation path:** user-visible changes are MoshOps commands: validate →
  one Tracktion undo transaction → mutate → JSONL log → events → structured
  result. UI and agent code never mutate Tracktion directly.
- **One undo system:** Tracktion's UndoManager is the implementation. View,
  machine, and monitoring preferences are not session edits and are honestly
  undoable:false.
- **Additive state:** preserve existing snapshot/event consumers. The UI couples
  to the backend through execute_command(...) plus snapshot and events.
- **Tier boundary:** generative rendering is an asynchronous local service job,
  never audio-thread work. The real-time RAVE/anira route is optional and off in
  the default build (MOSH_ENABLE_ANIRA).
- **Owner-machine safety:** do not kill or repurpose the owner router, active
  Codex/ChatGPT processes, an installed app, or a shared checkout to make a
  gate appear clean. Do not expose secrets from ~/.config/mosh/env.

## Selected source baseline

The serially merged pre-pivot product work is on main:

| PR | Selected result | What remains outside the merge claim |
|---|---|---|
| #663 | Owner-Mac recovery | Real device/recovery confirmation remains owner-gated. |
| #664 | Owner Music Night recovery | Physical audio remains manual. |
| #665 | Serum Live playback recovery | BlackHole/Serum-family playback confirmation remains manual. |
| #667 | Live 11 grid parity | Real Live interaction parity remains manual. |
| #666 | Re-Imagine VST3 | Audio-track Transfer, real SA3, Colours/LoRA by-ear, Set reopen, and model-release observation remain pending. |
| #668 | DAWN Bridge and Ableton Live 11 controller | Actual Live 11, iPhone reachability, recording, audible playback, routing preservation, and Live Undo remain pending. |

Fresh settings select the **V3** shell ("Mosh (v3)"). Pro Tools, Live, v2, and classic are
selectable; existing explicit user preferences are retained. This default is a
UI preference, not a statement of parity certification.

## Gate and evidence posture

Run the canonical local gate before a merge:

~~~sh
scripts/auto-loop/gate.sh native <candidate-worktree> origin/main
~~~

For final-baseline work, run the built application's --selftest three times and
--selftest-undo, plus the generated-scoreboard check and focused suites affected
by the change. A green gate, host discovery, screenshot, dashboard, or CI check
cannot prove audibility, physical recovery, installed-app behavior, Ableton
behavior, or iPhone behavior. Keep those owner acceptance boundaries explicit in
their subsystem evidence.

The memory preflight no longer counts agent child processes (removed
2026-09-01): that ceiling was a proxy for lingering Mosh instances that were not
being killed, and it blocked every native gate on a machine running ordinary
agent sessions. Stray Mosh processes are handled by the gate's port ownership
and kill_stray_services, not by a process-count heuristic.

## Paused and archived work

- **First-Stranger:** paused and archived. Its former
  [docs/first-stranger-program/README.md](docs/first-stranger-program/README.md)
  entrypoint is a tombstone; do not select a lane, invoke old lane tooling, or
  revive its launch/worktree instructions.
- **Finish My Song:** implementation remains present but development is paused;
  do not resume it without an explicit owner decision and fresh quality goal.
- **R8, legacy owner cockpit, and closed physical-repair work:** preserve as
  immutable archive tags/evidence rather than merging them into this baseline.
- **Session Foundry:** source and plan are archived only; Swift .build output is
  excluded and the work is not on main.
- **design-lab:** protected design playground branch; do not alter it.

## Repository safety

The canonical checkout is /Users/emiliosanchez-harris/Mosh; its shared Git
directory is /Users/emiliosanchez-harris/Library/Mosh/repo/ClaudeMosh.git and
must never be removed. Before deleting a linked worktree or a branch, verify a
pushed immutable archive/rescue tag and inspect git worktree list --porcelain.
Do not delete model, adapter, checkpoint, or evaluation evidence merely because
the associated experiment is paused.

## Current sources of truth

- [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md): selected baseline,
  archives, and manual acceptance boundaries.
- [docs/FEATURE_AUDIT.md](docs/FEATURE_AUDIT.md): generated parity scoreboard;
  regenerate with scripts/daw-conformance/scoreboard.py rather than editing it.
- [docs/VERIFICATION.md](docs/VERIFICATION.md): hardware/physical verification
  policy.
- The Re-Imagine and DAWN subsystem evidence records retain their detailed
  automated evidence and owner acceptance limits; do not replace those limits
  with a broad status claim.
