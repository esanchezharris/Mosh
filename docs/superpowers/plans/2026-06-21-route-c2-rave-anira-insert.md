# Route C.2 — real-time RAVE insert (Tier-A, via anira + LibTorch) Implementation Plan

> Heavy, gated sub-project. The DEFAULT build stays untouched (option OFF); the real
> plugin only compiles/links under `-DMOSH_ENABLE_ANIRA=ON`, which pulls LibTorch.

**Goal:** a real-time timbre-transfer **insert** — drop it on a track, pick a RAVE model, hear the
transfer live as the track plays — as a custom `te::Plugin` running RAVE via the **anira** inference
engine on LibTorch.

**Why anira:** it owns a background inference thread + RT-safe lock-free ring buffers, so
`applyToBuffer` never blocks (RAVE block inference is far too slow for the audio thread). This is the
prime-directive-correct way to host a heavy model in real time. Precedents: Scyclone (Torsion-Audio,
RAVE timbre-transfer JUCE plugin), Neutone FX/SDK, anira's own `nn-inference-template`.

**Tech:** C++/JUCE/Tracktion `te::Plugin`, anira (CPM, pinned), LibTorch (anira dependency).

## Global constraints
- DEFAULT build (option OFF) is byte-unaffected and stays green (selftest 888, etc.). All C.2 code is
  behind `#if MOSH_HAVE_ANIRA` / the `MOSH_ENABLE_ANIRA` CMake gate.
- Reuse the proven Tier-A patterns from git history (commit before `b33fb97`): RT-safe `applyToBuffer`,
  TRUE-latency `getLatencySeconds()` (RAVE has real block latency → PDC must be exact), dry/wet, atomic
  model swap, `describe()` for the snapshot, ASTD clamp on the expressive knob(s).
- Same model family as C.1 (RAVE `.ts`), so a user's `~/AI/rave-models/*.ts` works in both tiers.

## Tasks

### Task 1 — Build gate: re-add anira/LibTorch (gated OFF)
**Files:** `CMakeLists.txt`, `cmake/Dependencies.cmake`.
- Re-add `option(MOSH_ENABLE_ANIRA "Fetch anira + LibTorch for the real-time RAVE insert" OFF)`.
- Gated CPM block: `CPMAddPackage(NAME anira GITHUB_REPOSITORY anira-project/anira GIT_TAG <pin>)`;
  anira pulls LibTorch (its `ANIRA_WITH_LIBTORCH` backend). Define `MOSH_HAVE_ANIRA=1` on an interface
  target; link it into `Mosh` only when ON (mirror the removed `mosh_neural_backends`).
- **Verify:** default configure+build unchanged + selftest 888 (option present, OFF).

### Task 2 — `RaveInsertPlugin` (gated)
**Files:** `src/plugins/transform/RaveInsertPlugin.{h,cpp}` (all real code under `#if MOSH_HAVE_ANIRA`).
- A `te::Plugin` (`xmlTypeName "moshRaveInsert"`). Holds an `anira::InferenceHandler` configured for a
  RAVE model (`anira::InferenceConfig` with the model path + the RAVE I/O shape + a chosen backend).
- `prepareToPlay`/`initialise`: configure anira with the block size/SR; report anira's reported latency
  via `getLatencySeconds()` (exact → Tracktion PDC). `applyToBuffer`: push input to anira's ring,
  pull processed output (non-blocking; passthrough+latency until the first inference lands), dry/wet
  mix by the ASTD-mapped `mix` knob. No alloc / no lock on the audio thread.
- `loadModelFromFile(.ts)` on the message thread (atomic swap; old model kept alive past the swap).
  `describe()` for the snapshot (model name/path/loaded, latency, params).
- Gate-off: the whole class compiles to nothing (or a stub that isn't registered).

### Task 3 — MoshOps commands (gated) + registration
**Files:** `src/moshops/MoshOps.{h,cpp}`, `src/plugins/hosting/PluginHost.cpp`, `src/multiplayer/LockManager.cpp`.
- `#if MOSH_HAVE_ANIRA`: register `createBuiltInType<RaveInsertPlugin>()`; commands
  `add_rave_insert` / `set_rave_param` / `load_rave_model` / `reset_rave` (mirror the old neural
  command bodies from git history) + dispatch + snapshot field; LockManager → track-scoped.
- Gate-off: none of this exists (no dead command surface in the default build).

### Task 4 — UI rack card (gated by snapshot)
**Files:** `ui/src/ui/Dock.tsx`, `ui/src/types.ts`, `ui/src/bridge.mock.ts`.
- A rack card for a `rave` insert (model picker from `list_transform_targets` + ASTD mix slider +
  latency readout), shown only when the snapshot carries a `rave` plugin. A "+ RAVE" rack button gated
  on a capability flag from the snapshot/health (so it never appears in a default build that can't host
  it). Mock support for e2e.

### Task 5 — Verify (ON build)
- `cmake --preset macos-arm64-release -DMOSH_ENABLE_ANIRA=ON` → builds anira+LibTorch (LONG).
- PDC null/latency test (impulse emerges at exactly the reported latency); bypass passthrough;
  no-dropout RT-safety; with a real RAVE `.ts`: a `--run-script` render through the insert exports
  non-silent audio that differs from dry (offline render-to-WAV, gated `--rave-insert`).
- DEFAULT (OFF) build stays green throughout.

## Risk register (why this is the heavy rung)
- **LibTorch + JUCE + Tracktion is a known-finicky CMake combo** (symbol/dup-runtime/ABI issues are
  common). LibTorch is ~2.5 GB; the build is long and may need several integration fixes.
- **anira's RAVE config**: exact `InferenceConfig` (tensor shapes, latency, the chosen backend on
  arm64) must match the model export; first bring-up is iterative.
- **Verification needs a real model + measurement** (real-time can't be eyeballed headless) — the
  offline render-through-the-insert check is the proxy.
- **Mitigation:** everything is behind the gate; the default build/app are never at risk. The bring-up
  is opt-in and isolated. If LibTorch integration stalls, C.1 already delivers real transform value.

## Known follow-up (post-landing)
- **Offline-export quality:** during a faster-than-realtime ("fast") Tracktion render, anira (in realtime
  mode) logs "missing samples / catch-up" and the export has block-boundary artifacts (it still
  transforms — verified diff-RMS 0.547). Fix: expose `RaveEngine::setNonRealtime(bool)` →
  `InferenceHandler::set_non_realtime`, and have the plugin either declare itself realtime-only (so
  Tracktion renders export in realtime mode) or toggle non-realtime when it detects an offline render.
  **Live playback (the insert's purpose) is already correct** — anira keeps up in realtime.

## Recommended sequencing
Task 1 (gate, verifiable now, low-risk) → then the LONG LibTorch build + Tasks 2–5 as a focused
bring-up session. Task 1 can land green immediately; Tasks 2–5 are the heavy lift that wants a
dedicated run (and confirmation before pulling 2.5 GB of LibTorch).
