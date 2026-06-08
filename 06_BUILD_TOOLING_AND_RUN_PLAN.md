# 06 — Build Tooling & the Overnight Run Plan

*Scope: the build system (Pamplejuce adapted to a standalone-app target + a Vite frontend), dependency acquisition/pinning, tests/CI, the model-service packaging/launch, and the staged plan an autonomous run follows with its gates. Read first.*

**Depends on:** nothing (bootstrap). **Consumed by:** all modules.
**Primary references:** Pamplejuce (Sudara); Tracktion Engine's own CMake/`examples`; anira/RTNeural/chowdsp_utils build docs; Vite; JUCE 8 WebView.

> **Licensing:** out of scope — private personal research use. No license gating, nag screens, or commercial-license checks.

---

## 1. Target shape: app + bundled web UI

Mosh is a **standalone JUCE application** (not a plugin) that hosts a **bundled React/Vite UI** in a JUCE 8 WebView. Adopt Pamplejuce's *tooling patterns* — CMake structure, CPM dependency management, Catch2 test target, CI workflow, Ninja/sccache, Melatonin Inspector — but set the target as an app and lean on Tracktion's own CMake/example structure for engine integration. Don't force Mosh to *be* a Pamplejuce plugin; that mismatch is the known friction.

Add a **Vite build step** to CMake: build the `ui/` React app and stage its output where the WebView loads it (embedded resource or a known app-data path) for release; a dev mode may point the WebView at the Vite dev server.

---

## 2. Dependencies (CPM, pinned to commits)

| Dep | Role | Notes |
|---|---|---|
| **JUCE 8** | framework + WebView | Pulled via Tracktion; WebView native integration (`03`). |
| **tracktion_engine** | DAW engine/store | Pin a commit — all `// VERIFY` items resolve against it. |
| **anira** | RT-safe neural inference (Tier A) | Brings backend(s); choose per model (`04 §2.3`). |
| **RTNeural** | small-model inference (NAM/Proteus) | Same ecosystem as chowdsp. |
| **chowdsp_utils** | DSP blocks + plugin state/param helpers | For the neural insert's param/state plumbing. |
| **Catch2** | tests | Pamplejuce default. |
| *(dev)* **Melatonin Inspector** | native UI debug | Optional. |

**Frontend deps:** React + Vite + a small state store (Zustand/Redux/signals — implementer's choice), in `ui/package.json`. The frontend is intentionally light (`03`).

**Deliberately omitted in v0** (keep clean; document as deferred, not rejected): **foleys_gui_magic** (the UI is WebView now — foleys is unnecessary unless a native faceplate is later wanted); **cello** (MoshOps + Tracktion's UndoManager are the authority — `02` — so ValueTree sugar isn't needed); **Gin websockets / JUMP metering** (multiplayer deferred; metering is decimated events from the graph, `02 §4.2`).

**Inference backend (Apple Silicon primary):** ONNX Runtime or LibTorch via anira (`04 §2.3`). The SA3 service uses MLX (Python) separately — not a C++ dep.

---

## 3. Repo & CMake skeleton

Match `00 §5`. Top-level `CMakeLists.txt`: C++20; the standalone-app target; `CPMAddPackage` each pinned dep; add `tracktion_engine` module(s) + link; add `src/` by module (`engine`, `state`, `moshops`, `webview`, `plugins/hosting`, `plugins/neural`, `generative`); a custom command/target to build `ui/` via Vite and stage the bundle; the `tests/` Catch2 target; a hook to stage/launch the `service/` process. Borrow Pamplejuce's `cmake/` helpers, adapt the plugin bits to the app target.

---

## 4. Tests & CI

- **Catch2** units: the `MOSH_RENDERLAYER` schema + full-fingerprint cache key (round-trip, dirty logic); the ASTD mapping (0–100 ↔ clamped raw, per-param; Lab-mode unlock); MoshOps command validation + the result envelope; the snapshot serialization + event application; clip-position math.
- **Command-surface harness (the key test):** drive MoshOps with a scripted command sequence and assert results, emitted events, JSONL log lines, and snapshot state — this tests the spine and doubles as replayable regression. Because the UI is just a client of this surface, **most logic is testable without the UI**.
- **Neural insert harness:** instantiate `NeuralInsertPlugin`, run blocks, assert RT-safety (no allocations in `applyToBuffer`, rtsan-style) and that `getLatencySeconds()` matches measured delay (the PDC null test, `04 §2.4`). No Pluginval (that's for plugins; Mosh is an app).
- **CI** (GitHub Actions, Pamplejuce-style): build macOS arm64 (primary), build the Vite bundle, run Catch2 + the harnesses. Keep Win/Linux building if cheap.

---

## 5. The model service: packaging & launch

The generative model service (`service/`, the SA3 adapter carved per `05 §6` / App. B) is a separate Python process, **not** built by CMake.

- **External deps stay external:** the MLX SA3 port, the judge venv, the CLAP checkpoint — pointed at via env vars (`SA3_MLX_DIR`, `COLORRACK_DATA`). Don't vendor model weights.
- **Launch & lifecycle (`05 §4`):** the Generative Job Manager spawns/detects the service, performs the capability handshake + warmup, monitors heartbeat, restarts on crash, and cancels jobs on project close. Tier-B UI is gated on a successful handshake. A dev script (`service/run.sh`) runs it standalone.
- **`FakeAdapter`** needs none of the external deps — it lets Stage 5 proceed (and CI run) without the SA3 stack present.
- **MLX threading invariant:** engine thread owns the model; priority queue serializes renders ahead of background mints. Preserve from the existing server.

---

## 6. The staged run plan (gates from `00 §4`)

In order; **do not pass a failing gate.** Report against the concrete gate.

- **Stage 0 — Skeleton.** App builds (standalone); WebView loads the bundled React placeholder; CPM deps resolve; service stub answers health.
  *Gate:* window + placeholder on macOS arm64; service health ok.
- **Stage 1 — Engine + MoshOps + feed (`01`,`02`).**
  *Gate:* WebView renders a snapshot cold; `create_track`+`import_clip` via MoshOps; audio loops; undo/redo via MoshOps; JSONL records the commands; save/reload restores; test `MOSH_RENDERLAYER` survives.
- **Stage 2 — WebView arrangement (`03`).**
  *Gate:* arrange entirely from the UI (move/trim/split, transport, loop), responsive; meters/playhead via decimated events; **rebuild the React bundle with zero backend change and it still works** (swappability proof).
- **Stage 3 — VST3 hosting via commands (`04`).**
  *Gate:* VST3 synth from MIDI + effect on wave, all via commands; native editor opens; persists.
- **Stage 4 — Tier-A neural (`04`).**
  *Gate:* NAM tone + RAVE morph audible; **PDC null test passes**; bypass correct (test the known bug); no dropouts; ASTD clamps + Lab unlock — all via commands.
- **Stage 5 — Generative (`05`).** FakeAdapter first, then SA3.
  *Gate (Fake):* full loop via commands — submit → progress → audition → A/B → accept/reject; cache hit/miss vs fingerprint; source change → dirty → re-render; JSONL logs accept/reject (taste labels); no playback stall.
  *Gate (SA3):* real color + real re-imagine commit as auditionable take + quality readout; `/colors` drives knobs + ASTD; Lab unlocks; init-latent cache hit on seed-only change.
- **Stage 6 — Consolidation (`03`,`04`,`05`).**
  *Gate:* full producer loop from the UI (import/record → arrange → host VST3 → Tier-A insert → generative transform → mix → export); undo/redo correct throughout.

Build the arrangement incrementally within Stage 2/6 (static clips → drag/move → trim/split → zoom/snap → marquee).

---

## 7. Working notes for the autonomous run

- **Resolve every `// VERIFY` against the pinned `tracktion_engine` clone before relying on it** (VST3 editor accessor; takes/comp API; `LatencyPlugin` source; `Renderer::Parameters` fields; recent ctor signatures; JUCE 8 WebView native-fn/emit API). Prefer documented file-based fallbacks when uncertain (render-to-file over -to-buffer; new-clip over the takes API if opaque).
- **The spine first:** MoshOps + the snapshot/events feed is the highest-leverage early work; the UI and both neural tiers are clients of it. Get the contract right before building breadth.
- **FakeAdapter before SA3:** prove the generative orchestration (job/cache/RenderLayer/accept-reject/log) with the stub; swap the real model in last.
- **Apple Silicon first** (macOS arm64; matches the MLX service). Keep cross-platform clean; don't block on it.
- **Don't blur the tiers / don't bypass the spine:** Tier A in-process (anira); Tier B is a job via the adapter/service; **all** mutation through MoshOps; UI couples only via the contract.
- **Always leave an artifact:** if context runs low mid-stage, write a handoff note (state reached, gate status, next concrete step, `// VERIFY` resolved) before stopping.
