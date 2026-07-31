# Mosh Current Status And Architecture Map

Updated: 2026-07-30

> **This is the only rolling status doc.** Dated snapshots live in
> [`docs/resumption/`](resumption/). History lives in [`docs/worklog/`](worklog/INDEX.md).

This is the short handoff for the current `main` program seat at **`~/Mosh`**
(the git object store lives at `~/Library/Mosh/repo/ClaudeMosh.git`; see Branch
And Worktree Boundaries below). It points to the live docs that matter and calls
out what is current versus historical. Claims are tagged **[measured]** (ran or
read this session, 2026-07-28) or **[cited]** (a dated doc/worklog note).

## Start Here

0. This doc is the rolling status summary. The deeper dated snapshots are
   frozen history: `docs/STATUS_HANDOFF_2026-07-11.md` (the last full audited
   handoff) and `docs/resumption/2026-07-02-ground-truth-status-and-context.md`
   (the 2026-07-02 ground-truth extraction, moved here 2026-07-28). Neither is
   updated anymore.
1. `ARCHITECTURE.md` is the current architecture on-ramp. It explains the native
   macOS app shape: JUCE/Tracktion engine, React WebView UI, MoshOps seam,
   plugin/neural layers, Python generative service, brain/voice, and iPhone
   companion boundary.
2. `CLAUDE.md` is the run manifest: prime directives, stage gates, current build
   posture, deferred work, and the "gotchas that still bite" list.
3. `docs/worklog/` ([INDEX](worklog/INDEX.md)) is the dated session-note
   history — grep it before assuming a problem is new. `docs/PROGRESS.md` is
   retired (2026-07-28): it holds the 2026-06-08 → 2026-07-17 milestone history
   and takes no new entries.
4. `docs/FEATURE_AUDIT.md` is the DAW-parity scoreboard, regenerated from a live
   conformance run (`scripts/daw-conformance/`) against the real command surface
   (134/152 in-scope eval rows pass at its baseline) [cited].

## Current Product Shape

Mosh is a native Apple Silicon macOS DAW app. The audio engine, plugin hosting,
session state, command execution, native file dialogs, speech, remote companion
server, and app lifecycle live in C++/Objective-C++ under `src/`. The visible UI
is React/Vite under `ui/`, rendered inside a JUCE `WebBrowserComponent` bundled
inside `Mosh.app`; it is not Electron and does not rely on a web server in
production.

All user-visible mutations must cross the same seam:

```text
React WebView UI / Moshi agent
    -> src/webview WebBridge
    -> src/moshops MoshOps command
    -> validate, one Tracktion undo transaction, mutate, JSONL log, events
    -> snapshot + mosh_event feed back to UI
```

Heavy generative audio work stays out of the audio thread. There is a single
generative tier (Tier B): an async job through `src/generative` and `service/`
(re-imagine + timbre transform, working on any track). The synthetic Tier-A
neural insert was removed (2026-06-21); the only real-time neural path is an
optional RAVE insert gated behind `-DMOSH_ENABLE_ANIRA` (off in the default
build).

## Current Status (as of 2026-07-30)

- **Owner cockpit handoff is implemented on `codex/moshi-owner-cockpit`, not
  merged.** The disabled-by-default v2 surface, private loopback Agent Host,
  bounded capability retrieval, explicit provider failures, GPT Realtime PTT,
  durable approval inbox, immutable evidence/GitHub adapters, read-only Codex
  coordinator, and isolated draft-only repair lane are integrated. Task 5 adds
  a bundled real-loopback fake-external lifecycle and exact-SHA offline
  benchmark diagnostics; its final evidence is under
  `.omo/evidence/task-5-owner-handoff/`. No live OpenAI request, Supabase
  deployment, GitHub mutation, repair process swap, or final PR is part of the
  automated handoff. See [`OWNER_COCKPIT.md`](OWNER_COCKPIT.md). This branch
  supersedes only PR #478's agent-facing hunks; merge/disposition it serially
  after whole-branch review.

- **Trunk:** `origin/main` @ `c703a855` (merge of #490, 2026-07-29 early AM)
  [measured: `git log --oneline origin/main`]. The two most recent landed
  campaigns: the **v2 deslop pass** (#479, #481–#485, merged 2026-07-28) — CSS
  partials + shell baselines groundwork, bevel-border removal, accent
  reservation, bloom removal, density (64→72px lanes) — and the
  **architecture-improvement program** below [measured: merge commits on
  `origin/main`].
- **The architecture-improvement program is the active push.** Wave 0 landed
  2026-07-28: #486 (worklog INDEX repair + RED-proven guard) and #487
  (`docs/rfc/` decision-log scaffold, RFCs 001–004) are MERGED; #489
  (glob-aware god-file guards + the 209-row lock-scope golden ledger) passed
  the full native gate (selftest ×3 deterministic) and awaits **owner merge**
  (`needs-owner-merge` label). Wave 1 landed 2026-07-28/29: #490 (PROGRESS
  retirement), #491 (PluginBrowser dedupe), #493 (store event-rail
  extraction), #494 (Rack/GenDrawer out of Dock.tsx), #495 (classic-shell
  audit — owner decision pending, feeds RFC 005), and this status
  consolidation (#492). Follow-on PRs (clipRenderers probe change #497 —
  owner-merge; store slices #498; RFC 005 draft) are in the queue
  [measured: `gh pr view` per PR].
- **Open PRs: 25** [measured 2026-07-29: `gh pr list --state open | jq
  length`]. The bulk are the reviewed First-Stranger / fix backlog awaiting
  merge (#462–#478 range) plus the program's owner-merge PRs and three
  long-running WIP drafts (#322/#358/#363).
- **MoshOps dispatch table: 209 command entries** in `src/moshops/MoshOps.cpp`
  [measured: `grep -c 'if (name == "' src/moshops/MoshOps.cpp`]. Selftest check
  counts are deliberately **not** quoted here: they are environment-dependent
  (a dev Mac with SA3/RAVE/whisper weights, hermetic CI, and a Release bundle
  all report different totals — see CLAUDE.md "Gotchas that still bite"; never
  bake a locally-observed count into `MOSH_SELFTEST_BASELINE`).
- **GitHub Actions billing recovered 2026-07-27 — a red check is a REAL failure
  again, not an outage** [cited: the 2026-07-27 local-gating memory note; PR
  #468 updates CLAUDE.md accordingly]. Branch protection currently has **no
  required status check** (the `cheap gate` context was removed 2026-07-24
  during the outage; `enforce_admins` is still on) [measured:
  `gh api repos/zeke431/Mosh/branches/main/protection` → `required_status_checks:
  null`, `enforce_admins: true`]. The authoritative merge gate remains **LOCAL**
  (`scripts/auto-loop/gate.sh`: build, `Mosh --selftest`, focused undo, Catch2,
  vitest/e2e, golden audio) — restore the required context deliberately, not by
  reflex.
- **Landed 2026-07-18 → 07-26** (each cited to its dated worklog note):
  the arrangement-editing throughput window (18 PRs, #410–#427); DAW-parity
  claim enforcement (P0–P8); v2 track + master level meters (METER-001); the
  selftest-SIGSEGV diagnosis → AUD-001 root cause (ReverseRenderJob UAF) and
  root fix; the taste-label spigot restored (TASTE-002); the agentic-pass
  memory lane (M1–M4); **UI reachability closed 16 → 0** (every agent-catalog
  command now mouse-reachable from the shipped v2 shell, enforced by
  `ui/src/agent/uiReachability.test.ts`); and the FMS lyrics-first program's
  I1–I3a increments (infill bench + judge stack + benchmark repair)
  [cited: `docs/worklog/2026-07-18-*` … `2026-07-26-*`].
- The command surface remains the full DAW slice described in ARCHITECTURE.md:
  arrange editing, MIDI piano roll, transport/tempo/key, mixer, buses, sends,
  meters, recording, project lifecycle, import/export, plugin hosting,
  automation, render layers, iPhone companion, brain proxy, voice, 2-player
  multiplayer, DAW project import (RPP/ALS/FLP), audio→MIDI transcription, and
  the generative layer on any track. The **v2 UI shell is the default** (classic
  preserved in `AppLegacy.tsx` behind the `uiShell` setting).
- Platform posture is unchanged: macOS/Apple Silicon + MLX canonical; Windows +
  CUDA an additive port (owner-verified builds); Linux an exploratory spike
  (FIT-011). README and ARCHITECTURE §Platforms are the authoritative matrix.

## Active Programs

- [`first-stranger-program/`](first-stranger-program/) — the push to the first
  non-owner playtest. Its [STATUS.md](first-stranger-program/STATUS.md) board is
  machine-regenerated by `scripts/first-stranger/status.sh` (never hand-edit).
  Several of its reviewed lanes are in the open-PR queue above.
- [`fms-lyrics-bench/`](fms-lyrics-bench/) — the FMS lyrics-first benchmark
  program (charter + machine-regenerated scoreboard).
- The architecture-improvement waves (this docs consolidation is Wave 1's
  status lane; decision RFCs land under `docs/rfc/` via #487).

## Architecture Sources

| Area | Primary doc | Source entrypoints |
| --- | --- | --- |
| Whole app map | `ARCHITECTURE.md` | `src/Main.cpp`, `ui/src/App.tsx` |
| MoshOps command contract | `docs/02_MOSHOPS_CONTRACT.md` | `src/moshops/MoshOps.h`, `src/moshops/MoshOps.cpp` |
| Engine/session/source graph | `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` | `src/engine/MoshEngine.cpp`, `src/state/RenderLayer.h` |
| Plugin & neural chain | `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` | `src/plugins/hosting/PluginHost.h`, `src/plugins/transform/RaveInsertPlugin.h` (gated, `MOSH_ENABLE_ANIRA`) |
| Generative layer | `05_GENERATIVE_LAYER.md` | `src/generative/GenerativeJobManager.h`, `service/server.py` |
| Build/run plan | `06_BUILD_TOOLING_AND_RUN_PLAN.md` | `CMakeLists.txt`, `cmake/Dependencies.cmake`, `run-mosh.sh` |
| iPhone companion | `docs/IPHONE_COMPANION.md` | `src/remote/RemoteCompanionServer.h`, `ios/MoshCompanion/` |
| Type-beat LoRA scaffold | `docs/type-beat-trainer.md` | `src/training/`, `service/training/` |
| 2-player multiplayer | `supabase/README.md` | `src/multiplayer/`, `relay/server.py` |
| DAW project import | `docs/MOSHI_IMPORTERS.md` | `ui/src/import/`, `service/flp/` |
| Training-harvest format | `docs/MOSHI_TRAJECTORY_FORMAT.md` | `ui/src/harvest/`, `service/server.py` |
| Signing / release | `docs/release/SIGNING_RUNBOOK.md` | `run-mosh.sh` |
| Crash reporting / privacy | `docs/telemetry/PRIVACY.md` | `src/telemetry/` |
| Brain-key proxy | `docs/brain-proxy/RUNBOOK.md` | `src/brain/`, `supabase/` |

## Branch And Worktree Boundaries

- Main program seat: **`~/Mosh`** (moved out of iCloud 2026-07-16; a
  compatibility symlink remains at the old `~/Documents/ClaudeMosh` path). The
  git object store lives at `~/Library/Mosh/repo/ClaudeMosh.git` via a
  `gitdir:` pointer — never move the store or the checkout back under
  iCloud-synced `~/Documents`. The GitHub repo is `zeke431/Mosh`
  (renamed 2026-07-16; old URLs redirect).
- Agent work happens in per-task worktrees under the object store's
  `.claude/worktrees/` (one worktree = one agent). The proven dep-cache build
  recipe and the worktree traps live in CLAUDE.md "Gotchas".
- Design lab: `/Users/emiliosanchez-harris/Documents/ClaudeMosh-lab`, branch
  `design-lab`; do not use for program trunk hardening.

## Verification Commands

Use the local gate that matches the surface changed. For documentation-only
changes, link/lint review is normally enough. For code merges, start with:

```sh
cmake --build build-macos-arm64
APP=build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest
MOSH_NO_AUDIO=1 "$APP" --selftest-undo
ctest --test-dir build-macos-arm64 --output-on-failure
scripts/validate-command-log-contract.sh "$HOME/Library/Mosh/session-run-script/mosh-log.jsonl" 500
```

Then add the matching real-surface proof:

- UI or app behavior: run the app or the relevant `scripts/macos-ui-automation-*`
  gate and save screenshots/evidence under `_preserved_artifacts/`.
- Reactive/generative effects: `--selftest` cannot see the reactive lane — prove
  those in `verify.py`, run from the repo ROOT (see CLAUDE.md "Gotchas").
- Live audio, metering, recording, or neural A/B: use the CoreAudio smoke/demo
  commands with explicit input/output devices.
- Plugin-hosting changes: separate deterministic harness checks from slow
  full-library scans; hostile or unknown installed plugins are an environment
  risk, not a selftest dependency.
- iPhone companion: run `scripts/iphone-companion-sim-gate.sh` plus
  `scripts/iphone-companion-sim-media-gate.sh` for simulator coverage, then keep
  physical install/launch and real mic workflow proof as separate hardware gates.

## Known Open Risks

- Full plugin-library scans can still be machine-bound and slow because installed
  third-party plugins, especially Waves/unknown AUs, may hang or crash during
  load/teardown. The harness no longer depends on arbitrary installed plugins.
- BlackHole/CoreAudio loopback remains a hardware/environment gate, not a pure
  unit-test gate.
- Physical iPhone mic workflow still needs hands-on proof when that lane is
  active.
- Type-beat LoRA has a rights-cleared scaffold and fake backend plumbing; real
  on-device training and vector layering remain deferred.
- A large reviewed-PR queue (25 open, measured 2026-07-29) is waiting on merges now that Actions
  billing is back; until the required check is restored, the local gate is the
  only merge authority — do not treat a green GitHub page as a gate result.
