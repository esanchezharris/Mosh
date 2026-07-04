# Mosh Current Status And Architecture Map

Updated: 2026-06-27

This is the short handoff for the current `main`/`codex/docs` program seat in
`/Users/emiliosanchez-harris/Documents/ClaudeMosh`. It points to the live docs
that matter and calls out what is current versus historical.

## Start Here

0. `docs/resumption/2026-06-30-clean-resumption-map.md` is the current restart map
   for resuming after the Claude usage cutoff. It records the clean trunk baseline,
   dirty-work preservation lanes, open PR order, installed-app preservation policy,
   and why the autonomous loop must not be re-armed until backlog drift is fixed.
1. `ARCHITECTURE.md` is the current architecture on-ramp. It explains the native
   macOS app shape: JUCE/Tracktion engine, React WebView UI, MoshOps seam,
   plugin/neural layers, Python generative service, brain/voice, and iPhone
   companion boundary.
2. `CLAUDE.md` is the run manifest: prime directives, stage gates, current build
   posture, and deferred work.
3. `docs/PROGRESS.md` is the detailed chronological status log. It is the best
   place to check the newest landed work and verification counts.
4. `docs/FEATURE_AUDIT.md` is the DAW-parity scoreboard, regenerated from a live
   conformance run (`scripts/daw-conformance/`) against the real command surface
   (134/152 in-scope eval rows pass). It supersedes the 2026-06-09 baseline audit,
   now archived under `docs/archive/feature-audit-2026-06-09/`.
5. `docs/archive/hardening/2026-06-12-pause-alignment.md` is a historical pause
   marker, not the latest status. It is still important for branch boundaries and
   old parked work.

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

Heavy generative audio work stays out of the audio thread. There is now a single
generative tier (Tier B): an async job through `src/generative` and `service/`
(re-imagine + timbre transform, working on any track). The synthetic Tier-A neural
insert was removed (2026-06-21); the only real-time neural path now is an optional
RAVE insert gated behind `-DMOSH_ENABLE_ANIRA` (off in the default build).

## Current Status

- Trunk is macOS/Apple Silicon canonical. The PC portability remnants removed on
  2026-06-17 were re-landed as a deliberate additive Windows + NVIDIA/CUDA port on
  2026-06-20 (commit `962a03f`); it is built but **not yet verified on Windows
  hardware**. No Linux path. (Note: README and ARCHITECTURE §Platforms are the
  authoritative platform matrix.)
- The command surface has grown from the original six-stage v0 into a fuller DAW
  slice: arrange editing, MIDI piano roll, transport/tempo/key, mixer, buses,
  sends, meters, recording arm/monitoring, project lifecycle, import/export,
  plugin hosting, automation, render-layer management, iPhone companion, brain
  proxy, voice, 2-player multiplayer, DAW project import (RPP/ALS/FLP),
  audio→MIDI transcription, the type-beat LoRA trainer scaffold, and the first
  Mosh-native FX built-ins (`moshAutoTune`, `moshOTT`, `moshXFeedback`). The
  generative render layer now works on **any** track — MIDI/drum clips auto-bounce
  to audio first (re-imagine + timbre transform behind one model-agnostic adapter).
- **Landed 2026-06-21 → 06-27:** a from-scratch **v2 UI shell** is now the default
  (the classic shell is preserved verbatim in `AppLegacy.tsx`, selectable via the
  `uiShell` setting); the synthetic Tier-A neural insert was removed in favour of a
  single generative tier plus a gated real-time RAVE insert; generative layers run
  on any track; a **DAW-parity conformance gate** + regenerated `FEATURE_AUDIT.md`
  scoreboard (134/152); the packaged app bundles a brain key so a Finder/Dock launch
  always has a brain; a native Transport menu + deploy re-sign; iPhone-companion
  controller + latency gates; and an autonomous deferred-work loop (`docs/auto-loop/`)
  that cleared nine backlog items.
- The current default selftest target is **1046 command-surface checks** on the local
  machine, run 3× for determinism (gate-dependent — Serum-VST3 and SA3 gates add
  more). The UI side gates on vitest (584) + Playwright e2e (92), and a DAW-parity
  conformance run (`scripts/daw-conformance/`) replays a 152-invariant eval suite
  through the real command surface (134/152 in-scope pass). The hardening work fixed
  Serum VST3/AU ambiguity and selftest teardown crashes from arbitrary installed
  plugins by constraining harness-hosted plugins to a known-clean VST3 allowlist.
- The real local gate remains local, not hosted CI: build the app, run
  `Mosh --selftest`, run focused undo, and use app/manual gates for UI, audio,
  plugin-editor, iPhone, or hardware-sensitive work.
- GitHub Actions were removed on 2026-06-15 by owner decision. Do not assume PR
  checks exist.

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

## Branch And Worktree Boundaries

- Main program seat: `/Users/emiliosanchez-harris/Documents/ClaudeMosh`.
- Design lab: `/Users/emiliosanchez-harris/Documents/ClaudeMosh-lab`, branch
  `design-lab`; do not use for program trunk hardening.
- iOS continuation seat: `/Users/emiliosanchez-harris/Documents/ClaudeMosh-ios`,
  branch `codex/ios-companion-park`; do not merge to main without an explicit
  owner decision.
- Parked agent-training stack:
  `.claude/worktrees/laughing-grothendieck-22549c`; do not delete, clean, or port
  unless explicitly resumed.

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
- The feature audit (`docs/FEATURE_AUDIT.md`) is now the regenerated DAW-parity
  scoreboard (134/152 in-scope pass); the 17 gap rows (tracked as the G1–G14 backlog)
  plus 1 hardware row are the remaining conventional-DAW gaps. The 2026-06-09 baseline
  is archived under `docs/archive/feature-audit-2026-06-09/`.
