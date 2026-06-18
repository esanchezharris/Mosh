# Mosh — Current Status

*A single orientation doc: what Mosh is, what it isn't, how it's built, and what's
next. Snapshot as of **2026-06-14**, branch **`claude/ui-rebuild`**.*

> **Source-of-truth note.** This file is a human-readable snapshot. The
> authorities remain: `CLAUDE.md` (run manifest — stage gates + `// VERIFY`
> ledger), `AGENTS.md` (contributor rules + the merge gate), the `00`–`07` specs
> (the *how*), and the git log (the *what actually happened*). When this file and
> those disagree, trust them and update this file.

---

## TL;DR

Mosh is a **macOS / Apple-Silicon-only, AI-native hybrid DAW**. It is a standalone
JUCE 8 desktop app with a Tracktion Engine audio core, a React/Vite WebView UI, an
out-of-process Python generative service, and **Moshi** — a procedural PS2-era 3D
character who is the agent's face. Every user-visible change flows through **one
mutation path** (MoshOps commands) over **one undo system** (Tracktion's), and the
UI couples to the backend through a single **swappable seam** (`execute_command` +
a snapshot/events feed). The full spec build (Stages 0–6) is **complete and gated**;
the real generative model (Stable Audio 3 via MLX) is integrated behind a
model-neutral adapter. Current focus is a **PS2/Moshi UI rebuild** (reskin-in-place
over the durable layout, no C++ changes). Two large efforts — the agent-training
"flywheel" and the iOS companion hardening — are deliberately **parked on side
branches**, not on trunk.

---

## What Mosh *is*

- **A conventional DAW.** Tracks (audio/MIDI/group/bus), clips, an arrangement
  view (drag-move, edge-trim, split, zoom, snap-to-grid, marquee, ruler-seek,
  loop region), a piano-roll MIDI editor, a parameter-automation editor, a mixer
  (volume/pan/mute/solo + sends/buses), waveform rendering from backend peak
  arrays, tempo ramps, time-signature changes, audio warp, and synchronous
  WAV export of the whole signal chain.
- **A plugin host.** VST3 **and** AU hosting via commands (`load_plugin`,
  `remove_plugin`, `reorder_plugin`, `set_plugin_param`, `bypass_plugin`,
  `open_plugin_editor`) with native editor pop-outs. Plugin discovery is an
  **out-of-process deep scan** (a separate scan-worker child) that quarantines
  hanging shells and catalogs healthy VST3/AU plugins.
- **A real-time neural insert (Tier A).** `NeuralInsertPlugin` is a custom
  in-process `te::Plugin` with an RT-safe `applyToBuffer` (a preallocated, no-alloc
  2-layer tanh MLP waveshaper + a latency delay line). True PDC is reported and
  null-tested. It's a **model-agnostic host**: RTNeural captures and anira-pooled
  RAVE/DDSP are pinned and gated behind build flags.
- **A generative layer (Tier B).** An out-of-process Python service runs neural
  re-imagining as a job (file/manifest protocol: `input.wav` → `output.wav` +
  manifest). Ships with a deterministic **FakeAdapter** and a real
  **Stable Audio 3** adapter (in-process MLX, ~1.5s/render) driven by a validated
  **ASTD colour rack** (brightness/epic/distortion/futuristic/tension/grit/air/…),
  with a quality readout (Audiobox `pq`) and a full-fingerprint reuse cache.
- **Moshi — the agent's face.** A portable, zero-dep WebGL1 procedural creature
  (`ui/src/vendor/moshi.js`) with a procedural voice (`voice.js`) and an LLM brain
  (`brain.js`, key-safe via a Vite proxy). PS2-register render, second-order-dynamics
  motion, attention/poke behaviours, 9 material families. He reacts to a **real
  master spectral feed** (a Goertzel-based `MasterSpectralTapPlugin`) plus
  agent/engine state.
- **An iOS companion.** A SwiftUI app + a no-signing Safari web companion, served
  by a disabled-by-default `RemoteCompanionServer` (Bonjour-advertised, pairing-token
  gated). Phone mic takes import through the same MoshOps `import_clip` seam — the
  phone never mutates DAW state locally.
- **A type-beat LoRA trainer.** A rights-gated pipeline: import a source → attach a
  local file → approve → build a deterministic corpus bundle → submit to a remote
  trainer → import the finished adapter back into Mosh and activate it.

### The non-negotiable invariants (prime directives)

1. **One mutation path** — every change is a MoshOps command:
   validate → Tracktion undo transaction → emit events → JSONL log line →
   structured result envelope. The UI/agent never touch Tracktion directly.
2. **One undo system** — Tracktion's `UndoManager`. No shadow model. (Honest undo
   postures: machine/monitoring prefs are `undoable:false`.)
3. **Swappable seam** — the frontend knows only `execute_command(...)` + the
   snapshot/events feed. No audio/Tracktion concepts leak into the UI. *Proven:*
   rebuild the React bundle → the C++ binary is byte-identical.
4. **Tier wall** — Tier A is in-process and RT-safe; Tier B is always a background
   job via the service. No generative model on the audio thread, no RT sidecar.
5. **Threading** — model/bridge on the message thread; audio in `applyToBuffer` on
   RT threads (no alloc, never blocks); service I/O on background threads; telemetry
   decimated to 30 Hz.
6. **ASTD everywhere, defeatable** — every over-driveable neural param is a 0–100 UI
   control clamped below quality-collapse; **Lab mode** unlocks the raw range. One
   shared impl (`mosh::astd`).
7. **Cache by full fingerprint** — Tier-B reuse is keyed by the complete fingerprint
   (upstream hash · route · variant · seed · params · safety-mapping version ·
   service build), never just source+params.
8. **Snapshot/event changes are additive** — existing consumers never break.

---

## What Mosh is *not* (scope boundaries + honest gaps)

- **Not cross-platform.** macOS / Apple Silicon (arm64) **only** for v0. No
  Windows/Linux/CUDA code paths (unified-memory zero-copy is the load-bearing
  neural advantage). A `stable_audio3_cuda.py` exists but is not a v0 path.
- **Not shipping RAVE/DDSP in real time.** Tier A ships the self-contained MLP.
  RAVE/DDSP via anira+LibTorch are **gated** behind `MOSH_ENABLE_ANIRA` /
  `MOSH_ENABLE_RTNEURAL`, not on by default.
- **SA3 is gated, not always-on.** The real Stable Audio 3 model requires the MLX
  weights present (`SA3_MLX_DIR`) and env set; absent that, the service **gracefully
  downgrades to FakeAdapter**. The judges/QA venv (`MOSH_JUDGES_PY`) is likewise
  optional (QA degrades to `qa_unavailable`).
- **No verified audible neural A/B.** Tier-A inference is proven to alter signal
  (driven signal changes, silence stays silent) but a specific NAM/RAVE *audible*
  A/B has not been done (no model files / no ears in-loop historically).
- **The agent-training "flywheel" is not on trunk.** MoshIR, replay harness,
  trajectory store, collab sync, Monster/GEPA, the replication ladder — all live
  **only** on the parked `claude/laughing-grothendieck-22549c` branch. Resume = a
  deliberate port atop the current command surface, not a merge (~21 core files
  diverged).
- **Engine key detection is a stub.** Moshi's in-key voice contours wait on a real
  key from `mosh_event` (engine currently exposes tempo/time-sig only;
  `tempoKeyContext` is a placeholder in `RenderLayer.h`).
- **No multiplayer/CRDT yet.** Multiplayer is planned as **async git op-log sync**,
  not realtime CRDT — deferred.
- **Hosted CI is off.** GitHub Actions runs manual-only (`workflow_dispatch`);
  hosted macOS runners are paid. The **local battery is the merge gate.**
- **Hardware-gated items remain.** BlackHole loopback, CoreAudio device switching,
  and physical-iPhone signing are owner/hardware tasks (see *Owner to-dos*).

---

## Architecture

```
┌──────────────────────────── macOS app (Mosh.app, JUCE 8 standalone) ───────────────────────────┐
│                                                                                                  │
│  React/Vite WebView UI            │ couples ONLY via:                                            │
│  ui/  (Arrange, PianoRoll,        │   • execute_command(name, args) → result envelope           │
│   Automation, Mixer, Dock,        │   • snapshot()  + "mosh_event" feed (snapshot_invalidated   │
│   PluginBrowser, Topbar,          │     + 30 Hz decimated transport/meters/spectral)            │
│   Moshi GL character + voice)     │                                                              │
│            ▲   │                  ▼                                                              │
│            │   └────────── WebBridge / WebViewShell (native fns + event emit) ──────────────┐   │
│            │                                                                                 ▼   │
│   MoshOps  ── the ONE mutation path: validate → te transaction → events → JSONL → result envelope│
│      │  (src/moshops/)   ~118 commands: tracks/clips/arrange, mixer/buses/sends, automation,     │
│      │                   plugins (VST3/AU), neural insert, generative render layers, meters,     │
│      │                   training/LoRA, export, transport, undo/redo, save/reload                │
│      ▼                                                                                           │
│   MoshEngine (src/engine/) — owns ONE te::Engine + the Edit; Tracktion UndoManager = the undo    │
│      │                        impl. Session persists at ~/Library/Mosh/session/                  │
│      ├── PluginHost (src/plugins/hosting/) — VST3/AU host + native EditorWindow; OOP deep scan    │
│      ├── NeuralInsertPlugin (src/plugins/neural/) — Tier A, RT-safe MLP + ASTD (src/.../Astd.h)   │
│      ├── MasterSpectralTapPlugin (src/plugins/spectral/) — Goertzel feed → Moshi reactivity       │
│      ├── GenerativeJobManager (src/generative/) ──HTTP/ChildProcess──┐ (Tier B, background)       │
│      ├── RemoteCompanionServer (src/remote/) — iOS/Safari companion seam                          │
│      └── TrainingJobManager + TrainerRegistry (src/training/) — type-beat LoRA pipeline           │
│                                                                      │                            │
└──────────────────────────────────────────────────────────────────── │ ───────────────────────────┘
                                                                       ▼
                            Python generative service (service/) — out-of-process
                            server.py: submit/status/progress/cancel + /health /capabilities /colors
                            adapters/: fake_adapter.py  |  stable_audio3_adapter.py (MLX SA3-medium)
                            sa3/: engine.py, init_cache.py, qa.py, judge_sidecar.py (persistent QA)
                            colors/: COLORRACK_DATA + runtime.py (ASTD clamp/compose)
                            training/: corpus_builder, rights registry, lora_trainer_adapter
```

**Key design choices that shaped the build** (resolved `// VERIFY` items —
see `docs/ENGINE_API_NOTES.md`):

- New clips land via `insertWaveClip`; saves via `EditFileOperations(edit).save(...)`,
  not a bare `edit.save()`.
- Plugins must be created via `edit.getPluginCache().createNewPlugin(type, desc)`
  (not `PluginManager::createNewPlugin`) or `indexOf` fails and asserts.
- Tier-A latency: `getLatencySeconds()` returns the true delay; an internal delay
  line of exactly that length is applied to the output (even on bypass → constant
  latency, so PDC stays correct across bypass toggles).
- Tier-B render lands as a `WaveAudioClip` on a "Neural Renders" lane (the
  documented guaranteed fallback for accept/audition/reject).
- `export_audio` uses the **synchronous** `renderToFile` (the `Parameters` overload
  returns before the file exists); realtime export is auto-selected for plugins that
  require it (e.g. Serum 2).
- `te::Engine` is constructed with `autoInitialiseDeviceManager()=false` +
  `MOSH_NO_AUDIO` for headless/CI runs (the ctor otherwise auto-opens CoreAudio and
  wedges); plugin scan is out-of-process to avoid scan-child deadlock.

---

## Repo map

| Path | What lives there |
|------|------------------|
| `src/` | C++ backend: `engine/`, `moshops/`, `plugins/{hosting,neural,spectral}/`, `generative/`, `remote/`, `state/`, `training/`, `webview/`, `app/` (`MainWindow`, `WebViewShell`, `SelfTest`). |
| `ui/` | React/Vite WebView frontend. `ui/src/ui/*` surfaces; `ui/src/vendor/{moshi,voice}.js` the character; `bridge.ts` + `store.ts` the seam; Vitest unit tests + Playwright E2E. |
| `service/` | Out-of-process Python generative + training service (`server.py`, `adapters/`, `sa3/`, `colors/`, `training/`). |
| `ios/` | SwiftUI iPhone companion scaffold (`MoshCompanion/`). |
| `00`–`07` `.md` (root) | The canonical spec set (source of truth for *how*). |
| `CLAUDE.md` / `AGENTS.md` | Run manifest + contributor/merge rules. |
| `docs/` | `INDEX.md` (canonical-vs-stale map), `ENGINE_API_NOTES.md`, `02_MOSHOPS_CONTRACT.md`, `PROGRESS.md`, `FEATURE_AUDIT.{md,json}`, `hardening/`, `consolidation/`, `plans/`, `IPHONE_COMPANION.md`, `type-beat-trainer.md`. |
| `design-lab/` | Moshi design playground + curated lookbook (`HANDOFF.md`, `HOUSE_STYLE.md`, `LOOKBOOK.md`). Not program code. |
| `cmake/`, `patches/`, `scripts/`, `tests/`, `resources/`, `assets/` | Build deps/pins, the tracktion itemID patch, gate/automation scripts, Catch2 tests, bundled resources. |

---

## Capability status

| Area | Status |
|------|--------|
| Spec build Stages 0–6 | ✅ All six gates passed (2026-06-08). |
| Tier-B real model (SA3) | ✅ Gate passed — integrated behind the adapter; **gated** on MLX weights present, graceful downgrade to FakeAdapter. |
| 266-feature conformance audit | ✅ Must-tier 82/82 (`docs/FEATURE_AUDIT.md`). |
| AU hosting, tempo ramps, audio warp, itemID patch | ✅ On trunk. |
| Moshi character + voice + brain + spectral reactivity | ✅ v9; mounted in the UI; real Goertzel master feed. |
| Full UI rebuild (PS2/Moshi reskin) | 🔧 In progress on `claude/ui-rebuild` — Phases 0–4 done (tokens/motion, feels-alive, Moshi promotion, motion polish, grid-over-clips, MIDI/drum clip rendering). |
| OOP deep VST3/AU plugin scan | ✅ Recently landed (INS-006); kills the scan-worker child on finish. |
| Type-beat LoRA trainer | ✅ Pipeline present (rights-gated); end-to-end training is owner-budget-gated. |
| iOS companion | ✅ Baseline on trunk; hardening slice **parked** on `codex/ios-companion-park`. |
| Agent-training flywheel | ⏸ **Parked** on `claude/laughing-grothendieck-22549c` (do not delete; resume = port). |
| RAVE/DDSP real-time (anira) | ⏸ Pinned + gated, not shipping. |
| Multiplayer / CRDT | ⛔ Deferred (planned as async git op-log sync). |

---

## Build & verify

**Build target:** `juce_add_gui_app(Mosh ...)`, project version `0.0.1`.
Deps via CPM/FetchContent, pinned in `cmake/Dependencies.cmake`
(JUCE 8 `7c89e11f`, tracktion_engine `2877b621`, Catch2 `3.7.1`; anira/RTNeural/chowdsp
fetch-gated behind `-DMOSH_ENABLE_NEURAL=ON`).

**The local battery is THE merge gate** (paste tallies in the PR/commit):

```sh
cmake --build build
APP=build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest        # last main green: 650/650, 0 failed, 0 JUCE asserts
MOSH_NO_AUDIO=1 "$APP" --selftest-undo   # 18/18
ctest --test-dir build --output-on-failure
scripts/validate-command-log-contract.sh # last: 286 records
scripts/macos-ui-automation-gate.py
```

`650/650` is the last recorded figure on **main** (after `95c09e2`, 2026-06-12).
`claude/ui-rebuild` adds further commands/tests on top — **re-run the battery on
this branch**; treat the number as "650+/whatever the run reports", not a fixed value.

Frontend has its own fast layer: `npm --prefix ui run test` (Vitest unit) and
`npm --prefix ui run test:e2e` (Playwright). The generative service has Python smoke
tests under `service/scripts/`.

**Run the Moshi design lookbook:** `npm run dev` from `design-lab/playground` (port 5180).

---

## Branch topology

| Branch | Role |
|--------|------|
| `main` | The only development trunk. Wave-line: conformance audit, AU hosting, tempo ramps/warp, iOS baseline, Moshi. |
| `claude/ui-rebuild` | **← current.** The full PS2/Moshi UI rebuild (reskin-in-place over the durable layout). Where active product work is happening. |
| `design-lab` | Frozen archive of Moshi v1→v6 fine-grained history (own worktree `~/Documents/ClaudeMosh-lab`). Read-only reference. |
| `codex/ios-companion-park` (`f898d64`) | Parked iOS companion hardening (own worktree `~/Documents/ClaudeMosh-ios`). `codex/ios-companion-main-merge` is a prebuilt merge candidate — don't merge without a decision. |
| `claude/laughing-grothendieck-22549c` | **Parked** agent-training flywheel + its own DAW stages. Do not delete/clean up. Resume = port atop trunk. |
| `codex/maolan-engine-contract` (`a882854`) | Parked Maolan-engine experiment (5% done, wrong 5%). Product stays on Tracktion. |

---

## In flight right now (working tree)

On `claude/ui-rebuild`, **uncommitted**: a `--probe-plugin` diagnostic harness
(`Mosh --probe-plugin` with `MOSH_PROBE_PLUGIN_ID` set) that creates a fresh
headless track, resolves one catalog entry by id/name substring, and runs the normal
`load_plugin` command — returns 0 only on success. Touches `src/Main.cpp`,
`src/app/SelfTest.{cpp,h}`, and pins the CTest working directory in
`tests/CMakeLists.txt`. This is a plugin-load debugging aid (relevant to the Waves
install-conflict investigation), not yet committed.

---

## What's next

**Primary lane — finish the UI rebuild** (PS2/Moshi reskin-in-place; **no C++
changes** by design; the seam is additive and verified safe):

- Continue polishing the rebuilt surfaces; complete the reskin over the durable
  layout (Moshi stays paneled; PS2 motion in chrome).
- Point Moshi's event translator at the **live** `mosh_event` feed (today the lab
  uses mock events); add the agent-activity events the product still lacks
  (task-received, ambiguous, declined).
- Feed a **real key** into Moshi's voice once the engine exposes one (unblocks
  in-key contours).

**Moshi open threads** (from `design-lab/HANDOFF.md`):

- Bake the chosen anatomy (A/B/C), retire the stage chip.
- Fix faint edge ringing at TOON + PS2+ silhouette.
- Pose-vocabulary growth (POINT, LEAN-IN, sleep curl) + the parked bitmap-HUD face.

**Hardening (the documented next phase before new features):**

- Broader screenshot/vision-style UI review (not just deterministic command gates).
- Deeper piano-roll audits (fold/scale, humanize/swing, dense chords, multi-note).
- Arrangement coverage for trim/split/snap at zoom extremes + rapid undo/redo.
- Keep real plugin-editor windows in the rendered gate family (selftest can't prove
  native editor visibility).

**Resumable big lanes (owner-gated):**

- iOS companion continuation — in the `ClaudeMosh-ios` seat, not on trunk.
- Agent-training flywheel — port atop trunk when called; first step is the
  **trap-03 gold sign-off**.

**Deferred (do not build until asked):** multiplayer/CRDT op-log, on-device
SAO-Small + Medium→Small transfer, LoRA-base + vector layering, timestep-scheduled
steering, the full Context-Drawers system, the MRT2 live generative-instrument lane.

---

## Owner to-dos (human-only — block specific resumptions)

1. **BlackHole driver repair** (last red Mac gate): `sudo killall coreaudiod`;
   if still `ENV-BLOCKED`, `brew reinstall blackhole-2ch` then restart coreaudiod
   or reboot.
2. **Apple ID into Xcode** (blocks the physical-iPhone gate): sign in (free Personal
   Team is enough); `scripts/iphone-companion-device-gate.sh` auto-detects the team.
3. **GitHub Actions billing** (optional): hosted runners stay broken until fixed;
   nothing depends on them.
4. **trap-03 gold sign-off** (first flywheel-resume step): listen to the rung-1
   bounce vs the tutorial; sign-off flips the trajectory to gold.
5. **Budgeted training spends** (when training resumes): the GEPA campaign + the
   ~40-tutorial extraction pass.
6. **Waves install cleanup** (separate investigation): 4 conflicting WavesLib V16
   versions hang WaveShell on load for every host; ~1000 Waves plugins are
   unavailable until cleaned up. Mosh's OOP scanner correctly quarantines the
   hanging shells and catalogs the ~37 healthy VST3s.

---

## Canonical docs to read next

- `CLAUDE.md` — run manifest: prime directives, stage gates, `// VERIFY` ledger.
- `AGENTS.md` — contributor rules + the merge gate; lists parked branches.
- `docs/INDEX.md` — what's canonical vs a (possibly stale) status snapshot.
- `docs/hardening/2026-06-12-pause-alignment.md` — the pause marker (seats, last
  green battery, parked branches, resume procedures).
- `docs/ENGINE_API_NOTES.md` — resolved Tracktion signatures + file-based fallbacks.
- `design-lab/HANDOFF.md` — Moshi's full design state + open threads.
- `00`–`07` `.md` — the spec set (the *how*).
