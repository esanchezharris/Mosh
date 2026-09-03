# Mosh pre-pivot run manifest

This is a truthful checkpoint, not an active roadmap. The selected product
baseline is origin/main through **7eb0d617** (PR #668). The annotated tag
**pre-pivot-baseline-2026-08-23** identifies the final docs-only baseline after
it lands on main and completes final verification. Do not infer a future product
direction from this snapshot.

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

Fresh settings select the **Pro Tools** shell. Live, v2, and classic are
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
