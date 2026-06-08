# CLAUDE.md — Mosh Run Manifest

*Flat, tick-through checklist for the autonomous build. Collapses the gates and `// VERIFY` items from specs `00`–`06`. Place at repo root so Claude Code auto-loads it. Specs are the source of truth for **how**; this file is the source of truth for **what's done / what's next**.*

**Spec set:** `00_MOSH_MASTER_SPEC.md` (start) → `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` → `02_MOSHOPS_AND_STATE_FEED.md` → `03_WEBVIEW_UI.md` → `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` → `05_GENERATIVE_LAYER.md` → `06_BUILD_TOOLING_AND_RUN_PLAN.md`. `07_DEFERRED_AND_MODEL_NOTES.md` is context/parking-lot (model landscape, deferred lanes, license posture) — not build work.

---

## Prime directives (never violate)

- [ ] **One mutation path:** every user-visible change is a **MoshOps command** (validate → Tracktion undo transaction → emit events → JSONL line → structured result). UI/agent never mutate Tracktion directly.
- [ ] **One undo system:** Tracktion's `UndoManager` is the undo *implementation* under MoshOps. No second UndoManager, no shadow model.
- [ ] **Swappable seam:** the frontend couples to the backend **only** via `execute_command(...)` + the **snapshot+events** feed. No Tracktion/audio concepts in the frontend. Pure view state (drawers, zoom, scroll, selection) is UI-local and **not** a command.
- [ ] **Tier wall:** Tier A (NAM/Proteus/RAVE/DDSP) runs **in-process via anira**; Tier B (generative) is a **job via the adapter/service**. No generative model in anira; **no real-time sidecar**.
- [ ] **Threading:** model + bridge on the message thread; audio in `applyToBuffer` on RT threads; rendering/thumbnails/freeze/service-I/O on background; **audio thread never blocks**; telemetry to UI **decimated 30–60 Hz**, never per-block.
- [ ] **ASTD everywhere, defeatable:** every over-driveable neural param is a 0–100 UI control clamped below quality-collapse by default; **Lab mode** unlocks the raw range behind a warning. One shared impl, both tiers.
- [ ] **Cache by full fingerprint:** Tier-B reuse keyed by the complete fingerprint (`05 §5`), never just source+params.
- [ ] **FakeAdapter before SA3:** prove the generative orchestration with the stub; swap the real model in last.
- [ ] **VERIFY before relying:** resolve every `// VERIFY` against the **pinned `tracktion_engine` clone**; take the **documented file-based fallback** when uncertain.
- [ ] **macOS / Apple Silicon (arm64) ONLY for v0.** No Windows/Linux/CUDA paths. Lean into MLX/CoreML/Metal + unified memory. Cross-platform is a later concern.
- [ ] **Gate discipline:** never advance past a failing gate; report against the concrete gate.
- [ ] **Always leave an artifact:** low on context mid-stage → write a handoff note before stopping.

---

## Build stages & gates

### Stage 0 — Skeleton (`06`) ✅ GATE PASSED (2026-06-08)
- [x] Standalone-app target builds; not a plugin target. (`juce_add_gui_app`; `Mosh.app` built+linked.)
- [x] CPM deps resolve & pin: JUCE 8 (`7c89e11f`, via tracktion submodule), tracktion_engine (`2877b621`), Catch2 (`3.7.1`). anira/RTNeural/chowdsp **pinned in `cmake/Dependencies.cmake`, fetch-gated behind `-DMOSH_ENABLE_NEURAL=ON`** (resolve fully at Stage 4 to keep the skeleton build fast).
- [x] Vite builds `ui/`; JUCE 8 WebView loads the bundled React placeholder. (Served via `WebBridge` resource provider from `Mosh.app/Contents/Resources/ui`.)
- [x] Generative service stub answers a health check. (`service/server.py`; `/health` + `/capabilities` ok.)
- [x] **GATE:** window + placeholder on macOS arm64; service health ok. **Bonus:** native bridge round-trips (`ping()` → app identity) — the swappable seam is functional, a Stage 1 prereq done early.

### Stage 1 — Engine + MoshOps + state feed (`01`,`02`)
- [ ] `Engine` constructed once; device auto-init; `Edit` created; `edit.getUndoManager()` is the undo impl under MoshOps.
- [ ] MoshOps `execute()` with result envelope + validation + per-command Tracktion transaction + JSONL log.
- [ ] `getSnapshot()` + typed event stream (snapshot+events, "c"); first commands: `create_track`, `import_clip`, `set_transport`.
- [ ] `MOSH_RENDERLAYER` schema defined; test node round-trips save/load.
- [ ] **GATE:** WebView renders a snapshot cold; `create_track`+`import_clip` via MoshOps; audio loops; scrub; undo/redo via MoshOps; JSONL records the commands; save/reload restores.

### Stage 2 — WebView arrangement (`03`)
- [ ] Conventional layout: track headers, timeline lanes, clips, transport bar, mixer stub.
- [ ] Playhead + meters via **decimated** events (30–60 Hz); waveforms from backend peaks/thumbnail (no audio on web thread).
- [ ] All mutation via MoshOps; clip drag/trim/split → `move_clip`/`trim_clip`/`split_clip`.
- [ ] **GATE:** arrange entirely from the UI (move/trim/split, transport, loop), responsive; **rebuild the React bundle with zero backend change and it still works** (swappability).

### Stage 3 — VST3 hosting via commands (`04`)
- [ ] `load_plugin`/`remove_plugin`/`reorder_plugin`/`set_plugin_param`/`bypass_plugin`/`open_plugin_editor`; native editor pop-out.
- [ ] **GATE:** VST3 synth from MIDI + effect on wave, all via commands; native editor opens; persists.

### Stage 4 — Tier-A real-time neural (`04`)
- [ ] `NeuralInsertPlugin` (custom `Plugin`) registered via `createBuiltInType<>()`; anira; RT-safe `applyToBuffer`; warm-up.
- [ ] **NAM/Proteus ship**; **RAVE behind a gate**; DDSP in set; model-agnostic host + per-model param maps.
- [ ] `getLatencySeconds()` returns the **true** delay; knobs via `add_neural_insert`/`set_neural_param`; ASTD-clamped; `set_neural_lab_mode`.
- [ ] **GATE:** NAM tone + RAVE morph audible; **PDC null test passes (no drift)**; bypass correct (test the known inverted-logic bug); no dropouts; ASTD clamps + Lab unlock — all via commands.

### Stage 5 — Generative layer (`05`) — Fake first, then SA3
- [ ] `GenerativeModelAdapter` interface; **`FakeAdapter`** returns deterministic placeholder audio.
- [ ] Job service: submit/status/progress/cancel + lifecycle (warmup/heartbeat/crash-restart/cancel-on-close); audio over files+manifests.
- [ ] RenderLayer flow + full cache fingerprint; commands: `create_render_layer`/`set_render_param`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`/`bypass_layer`/`freeze_layer`/`bounce_layer_to_clip`.
- [ ] Then **`StableAudio3Adapter`** (carve per App. B; env-var the two hardcoded paths): colors + ASTD/Lab, two control vocabularies, generate + re-imagine (`nl ≤ 0.5`), init-latent cache, judge-panel QA, ≤3-color cap.
- [ ] **GATE (Fake):** full loop via commands — submit → progress events → audition → A/B vs source → accept/reject; cache hit/miss vs fingerprint; source change → dirty → re-render; JSONL logs accept/reject (taste labels); no playback stall.
- [ ] **GATE (SA3):** real `grit` + real re-imagine commit as auditionable take + quality readout; `/colors` drives knobs+clamps; Lab unlocks; init-latent cache `hit` on seed-only change.

### Stage 6 — Consolidation (`03`,`04`,`05`)
- [ ] Mixer polish; two-theme system (shared tokens); reserved B-5 slot (empty); optional prompt-concision rewriter + quality readout.
- [ ] **GATE:** full producer loop from the UI (import/record → arrange → host VST3 → Tier-A insert → generative transform → mix → export); undo/redo correct throughout.

Build the arrangement incrementally within Stage 2/6: static clips → drag/move → trim/split → zoom/snap → marquee.

---

## Consolidated `// VERIFY` (resolve against the pinned clone)

**Engine / state (`01`)** — see `docs/ENGINE_API_NOTES.md` for exact signatures
- [x] `createEmptyEdit` / `Edit` ctor / `insertNewAudioTrack` signatures. RESOLVED: `te::createEmptyEdit(engine, file)→unique_ptr<Edit>`; `edit.insertNewAudioTrack(TrackInsertPoint, SelectionManager*, bool)` or `ensureNumberOfAudioTracks`+`getAudioTracks(edit)[i]`; `insertWaveClip(name,file,ClipPosition,bool)`.
- [x] Edit save call. RESOLVED: `te::EditFileOperations(edit).save(warn,force,offerDiscard)` / `.writeToFile(file,quick)` — NOT a bare `edit.save()`.
- [ ] `MOSH_RENDERLAYER` parent: clip (default) vs track. (Decide at Stage 5; start under clip.)

**MoshOps / feed (`02`)**
- [ ] Event-vs-snapshot granularity per surface; undo/redo as `snapshot_invalidated` resync vs precise inverse-deltas.
- [ ] Whether selection is mirrored to backend (prefer explicit command target args).

**WebView (`03`)**
- [x] JUCE 8 WebView native-fn registration + C++→JS emit API. RESOLVED + working: `WebBrowserComponent::Options().withNativeIntegrationEnabled().withResourceProvider(...).withNativeFunction(id, fn)`; emit via `wb.emitEventIfBrowserIsVisible(id, var)`. UI imports JUCE's own vendored `getNativeFunction` (`ui/src/juce/`). `ping()` round-trips live.
- [ ] Waveform delivery (peak array per clip vs server-rendered image) — start peak array. (Stage 2.)

**Plugins / Tier A (`04`)**
- [x] `ExternalPlugin` editor-window accessor. RESOLVED: `ExternalPlugin::getAudioPluginInstance()` → `createEditorIfNeeded()` / `GenericAudioProcessorEditor`; `te::Plugin::EditorComponent` + `PluginWindowState` (see `examples/common/PluginWindow.h`).
- [ ] `LatencyPlugin` `.h/.cpp` source (copy latency pattern exactly). (Custom-plugin template resolved via `DistortionEffectDemo.h`; copy LatencyPlugin's reporting at Stage 4.)
- [ ] anira `InferenceHandler::process`/`prepare` on the pinned version.
- [ ] NAM/Proteus inline (RTNeural) vs via anira — measure; default to anira's pool.
- [ ] Bypassed-plugin PDC (`allowBypassedProcessing`/`canProcessBypassed`; forum #53709 bug).

**Generative (`05`)**
- [ ] Takes/comp add+promote API — `CompManager`/`WaveCompManager`; new-clip-on-new-track fallback.
- [ ] `Renderer::Parameters` fields + `renderToFile` overload (`tracksToDo` bitset, `allowedClips`).
- [ ] Render-to-file (preferred) vs -to-buffer.
- [ ] Carve-out external deps present; two hardcoded paths parameterized (App. B).

---

## Working notes

- **macOS / Apple Silicon (arm64) only** (matches the MLX service). Unified-memory zero-copy is the load-bearing neural advantage; no cross-platform code paths in v0.
- **Spine first:** MoshOps + snapshot/events is the highest-leverage early work — UI and both neural tiers are clients of it.
- **The swappability gate (Stage 2)** is non-negotiable: rebuild the React bundle, zero backend change.
- **FakeAdapter before SA3** (Stage 5) — prove orchestration with the stub.
- The **arrange view** is incremental, not a from-scratch native renderer (it's React over the `02` contract) — lower risk than the prior plan, but still stage it.
- Optional non-blocking adds once core works: prompt-concision rewriter (`05 §6`), judge-panel quality readout (`05 §7`), `StableAudioOpenSmallAdapter` bring-up rung (`05 §2`).
- Deferred (do **not** build): B-5/operator behavior + multiplayer/CRDT op-log; on-device SAO-Small + Medium→Small transfer; LoRA-base + vector layering; timestep-scheduled steering; full Context-Drawers system; **MRT2 live generative-instrument lane** (more viable now we're Mac-only, but not core v0 — `07`); foleys/cello/Gin/JUMP (only if a later need appears).
