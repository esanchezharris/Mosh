# CLAUDE.md — Mosh Run Manifest

*Flat, tick-through checklist for the autonomous build. Collapses the gates and `// VERIFY` items from specs `00`–`06`. Place at repo root so Claude Code auto-loads it. Specs are the source of truth for **how**; this file is the source of truth for **what's done / what's next**.*

**Spec set:** `00_MOSH_MASTER_SPEC.md` (start) → `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` → `02_MOSHOPS_AND_STATE_FEED.md` → `03_WEBVIEW_UI.md` → `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` → `05_GENERATIVE_LAYER.md` → `06_BUILD_TOOLING_AND_RUN_PLAN.md`.

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
- [ ] **Apple Silicon first** (macOS arm64). Cross-platform clean; don't block on it.
- [ ] **Gate discipline:** never advance past a failing gate; report against the concrete gate.
- [ ] **Always leave an artifact:** low on context mid-stage → write a handoff note before stopping.

---

## Build stages & gates

### Stage 0 — Skeleton (`06`)  — *spine+scaffold verified on Windows; window gate needs macOS*
- [x] Repo scaffold (`00 §5`), git init, `.gitignore`, README, STATUS.
- [x] Standalone-app target **builds + links + launches** on Windows (MSVC 19.44 + WebView2 SDK); native "Mosh" window opens. No Tracktion until Stage 1.
- [x] CPM deps **pinned** (JUCE 8.0.8, tracktion v3.2.0, anira v2.0.3, RTNeural, chowdsp, Catch2 v3.9.1, CPM v0.42.3). JUCE+Catch2 **resolved & built**; Tracktion fetched at Stage 1.
- [x] Vite builds `ui/` → `dist/` (verified green); staged next to the exe by the build.
- [x] Generative service stub answers `/health` (verified: 200 + ok JSON; `/capabilities`; 404).
- [x] **Spine verified:** `mosh_tests` = **158 assertions / 30 cases green** — MoshResult envelope, ASTD clamp+Lab+skew, full-fingerprint cache key, RenderLayer round-trip/dirty/≤3-color cap, event shape+decimation, **command-surface harness** (results/events/JSONL/snapshot/undo-redo/abandon), ClipMath move/trim/split.
- [~] **GATE:** window + placeholder on macOS arm64; service health ok. *(Windows proxy: build+links+window ✅, service health ✅; WebView **placeholder render** shows WebView2 "navigation canceled" — the JUCE-8 WebView resource `// VERIFY`, deferred to Stage 2 / a macOS WKWebView run. See STATUS.)*

### Stage 1 — Engine + MoshOps + state feed (`01`,`02`) — *backend verified over real Tracktion; WebView-render + audio-loop need Stage 2 / a run*
- [x] `Engine` constructed once (1-arg ctor; device auto-init); `Edit` via `createEmptyEdit`; `edit.getUndoManager()` is the undo impl under MoshOps. **Compiles + links against real Tracktion v3.2.0 on Windows.**
- [x] MoshOps `execute()` result envelope + validation + per-command Tracktion transaction + JSONL log (spine; now driving Tracktion handlers).
- [x] `getSnapshot()` walks the Edit + typed events; commands: `create_track`, `import_clip`, `set_transport`, `set_tempo`, `rename_track`, `set_track_gain/mute/solo`, `delete_track`, `move_clip`, `trim_clip`, `split_clip`.
- [x] `MOSH_RENDERLAYER` schema defined; node round-trips save/load (spine `mosh_tests`).
- [x] **Smoke test green over real Tracktion** (`mosh_engine_tests`, 23 assertions): `create_track`+`import_clip`(real WAV) via MoshOps; **undo/redo via MoshOps reverts/restores** (one undo system confirmed); `save()` round-trips `.tracktionedit`; tempo/transport reflected; JSONL records commands.
- [~] **GATE:** WebView renders a snapshot cold *(blocked on Stage-2 WebView resource render)*; audio loops + scrub *(needs a run; transport commands execute)*. **Backend half of the gate (commands/undo/JSONL/save) ✅ verified.**

### Stage 2 — WebView arrangement (`03`) — *BLOCKED on the WebView render (Windows WebView2 cancels the resource-root nav; needs the macOS WKWebView run / a WebView2 fix — see STATUS "OPEN ISSUE"). Backend seam is ready.*
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

### Stage 5 — Generative layer (`05`) — Fake first, then SA3 — *orchestration spine proven (out of order, since Stage 2/4 are platform-blocked here)*
- [x] `GenerativeModelAdapter` interface + **`FakeAdapter`** (deterministic placeholder) + `RenderCache` + the `renderLayer` orchestrator (`src/spine/Generative.h`). **Tested (25 assertions): cache HIT/MISS keyed by the FULL fingerprint, any-input-change → dirty → re-render, deterministic-per-fingerprint output, accept/reject taste labels.** Pure spine — no MLX/service/UI. Job service (Python submit/status/progress/cancel) + Tracktion-take landing are the next increment.
- [x] Job service + **C++↔service loop — DONE + verified end-to-end on Windows**. Python `service/` (stdlib: `POST/GET/DELETE /jobs`, deterministic placeholder WAV+manifest keyed by `cacheKey`, cooperative cancel, 404). C++ `GenerativeJobManager` (spine; spawns the service, `/health` handshake, submit/poll/cancel over HTTP, reads manifest) + `renderLayerViaService()`. `mosh_service_tests` (16 assertions): submit → poll progress → manifest WAV → cache; **cache HIT** on same fingerprint, **dirty → MISS** on changed seed. Lifecycle (heartbeat/crash-restart/cancel-on-close) still to harden.
- [ ] RenderLayer flow + full cache fingerprint; commands: `create_render_layer`/`set_render_param`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`/`bypass_layer`/`freeze_layer`/`bounce_layer_to_clip`.
- [ ] Then **`StableAudio3Adapter`** (carve per App. B; env-var the two hardcoded paths): colors + ASTD/Lab, two control vocabularies, generate + re-imagine (`nl ≤ 0.5`), init-latent cache, judge-panel QA, ≤3-color cap.
- [~] **GATE (Fake):** **backend loop VERIFIED on Windows** (submit → progress → render via service → cache hit/miss vs full fingerprint → source change → dirty → re-render — `mosh_service_tests`). **Remaining:** drive it through the MoshOps command surface (`render_layer`/`accept_render`/`reject_render` + `layer_render_progress`/`layer_rendered` events + JSONL taste labels), the audition/A-B UI (Stage 2 WebView), and accept-as-take landing (engine). No playback stall = needs a run.
- [ ] **GATE (SA3):** real `grit` + real re-imagine commit as auditionable take + quality readout; `/colors` drives knobs+clamps; Lab unlocks; init-latent cache `hit` on seed-only change.

### Stage 6 — Consolidation (`03`,`04`,`05`)
- [ ] Mixer polish; two-theme system (shared tokens); reserved B-5 slot (empty); optional prompt-concision rewriter + quality readout.
- [ ] **GATE:** full producer loop from the UI (import/record → arrange → host VST3 → Tier-A insert → generative transform → mix → export); undo/redo correct throughout.

Build the arrangement incrementally within Stage 2/6: static clips → drag/move → trim/split → zoom/snap → marquee.

---

## Consolidated `// VERIFY` (resolve against the pinned clone)

**Engine / state (`01`)**
- [ ] `createEmptyEdit` / `Edit` ctor / `insertNewAudioTrack` signatures (strong time-type migration).
- [ ] Edit save call (`EditFileOperations` vs `edit.save()`).
- [ ] `MOSH_RENDERLAYER` parent: clip (default) vs track.

**MoshOps / feed (`02`)**
- [ ] Event-vs-snapshot granularity per surface; undo/redo as `snapshot_invalidated` resync vs precise inverse-deltas.
- [ ] Whether selection is mirrored to backend (prefer explicit command target args).

**WebView (`03`)**
- [ ] JUCE 8 WebView native-fn registration + C++→JS emit API (`window.__JUCE__.backend`).
- [ ] Waveform delivery (peak array per clip vs server-rendered image) — start peak array.

**Plugins / Tier A (`04`)**
- [ ] `ExternalPlugin` editor-window accessor.
- [ ] `LatencyPlugin` `.h/.cpp` source (copy latency pattern exactly).
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

- Primary target **macOS arm64** (matches the MLX service). Unified-memory zero-copy is the load-bearing neural advantage.
- **Spine first:** MoshOps + snapshot/events is the highest-leverage early work — UI and both neural tiers are clients of it.
- **The swappability gate (Stage 2)** is non-negotiable: rebuild the React bundle, zero backend change.
- **FakeAdapter before SA3** (Stage 5) — prove orchestration with the stub.
- The **arrange view** is incremental, not a from-scratch native renderer (it's React over the `02` contract) — lower risk than the prior plan, but still stage it.
- Optional non-blocking adds once core works: prompt-concision rewriter (`05 §6`), judge-panel quality readout (`05 §7`).
- Deferred (do **not** build): B-5/operator behavior + multiplayer/CRDT op-log; on-device SAO-Small + Medium→Small transfer; LoRA-base + vector layering; timestep-scheduled steering; full Context-Drawers system; foleys/cello/Gin/JUMP (only if a later need appears).
