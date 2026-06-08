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
- [x] **Persistence verified** (`test_persistence`, `[persist]`): tracks/clips/plugins/**neural insert** survive a save → **fresh-session reload** (`saveAs`/`loadEditFromFile`; the custom plugin deserializes via its `createBuiltInType` registration). Covers Stage 1 "save/reload restores" + Stage 3 "persists".
- [~] **GATE:** WebView renders a snapshot cold *(blocked on Stage-2 WebView resource render)*; audio loops + scrub *(needs a run; transport commands execute)*. **Backend half (commands/undo/JSONL/save-reload) ✅ verified.**

### Stage 2 — WebView arrangement (`03`) — *arrange loop now driven from a real browser against the REAL backend over HTTP (Windows-verified); only the in-app WebView render is macOS-blocked*
- [x] Conventional layout built (`ui/src/components/`): `TransportBar`, `TrackList` (headers: rename/gain/M/S/arm/delete + plugin chips), `Timeline` (Ruler/Lanes/ClipViews/Playhead/loop overlay/zoom), `Mixer` strips.
- [x] Playhead + meters via **decimated** events (60 Hz `transport_position`/`meter_update`); per-clip faked waveforms (no audio on the web thread, 03 §5).
- [x] All mutation via MoshOps; clip drag/trim/split → `move_clip`/`trim_clip`/`split_clip`; transport/tempo/track/plugin/neural/render-layer commands wired. View state (selection/zoom/scroll) is UI-local.
- [x] **Browser-verified against the REAL backend over HTTP** (`src/app/HttpBridge`; Playwright + real Tracktion): `+ Track`→`create_track`, click-lane→`import_clip` (real tone-WAV), drag→`move_clip`, edge→`trim_clip`, dbl-click→`split_clip`, ▶/■→`set_transport`, ↶/↷+Ctrl+Z→`undo`/`redo` — **UI↔backend in perfect sync every step**. Reliability fixes: non-destructive seq-cursor `/api/events`, load-time event buffer, tone-clip fallback, UI undo/redo. (Also earlier browser-verified against the contract-faithful mock.)
- [x] **GATE (over HTTP, Windows-verified):** arrange entirely from the UI (create/move/trim/split, transport, undo/redo) against the **real Tracktion backend** in a browser; **React bundle rebuilt ~6× with zero backend-seam change and it kept driving the real backend** → swappability proven (`backend:mock` ↔ `backend:juce`/http). **Remaining (macOS):** the *in-app* JUCE WebView render (WKWebView) + loop-region/meters best confirmed there + audio. See STATUS "BREAKTHROUGH".

### Stage 3 — VST3 hosting via commands (`04`) — *command surface verified with built-ins; real VST3 + native editor need macOS*
- [x] `load_plugin`/`remove_plugin`/`reorder_plugin`/`bypass_plugin` over Tracktion's plugin model (`src/engine/PluginCommands`), snapshot surfaces each track's `plugins[]` ({id,type,name,bypassed}). `test_plugin_commands` (`[plugins]`, 16 assertions): load a built-in (`createNewPlugin`+`insertPlugin`) → snapshot reflects → bypass (`setEnabled`) → remove → **undo restores** → unknown type/plugin → stable errors.
- [ ] `set_plugin_param` (AutomatableParameter API) + `open_plugin_editor` (native pop-out; the `ExternalPlugin` editor `// VERIFY`) — land on macOS where editors + scanned VST3s run.
- [ ] **GATE (macOS):** VST3 synth from MIDI + effect on wave via commands; native editor opens; persists. *(Command surface ✅ on Windows with built-ins; real VST3 hosting + editor + audio = macOS.)*

### Stage 4 — Tier-A real-time neural (`04`) — *insert architecture + ASTD command surface verified; anira inference + PDC null test need macOS*
- [x] `NeuralInsertPlugin` (custom `te::Plugin`) **registered via `createBuiltInType<>()`**, lives in the track's `pluginList`; RT-safe passthrough `applyToBuffer` (allocates nothing); `getLatencySeconds()` returns a stored true-delay (0 for passthrough). anira warm-up/inference drop into `initialise()`/`applyToBuffer()` on macOS.
- [ ] **NAM/Proteus ship**; **RAVE gated**; DDSP — the anira model host + per-model param maps (macOS; the // VERIFY anira `process`/`prepare`).
- [x] `getLatencySeconds()` true-delay hook; knobs via `add_neural_insert`/`set_neural_param` (**ASTD-clamped, one shared spine impl**) / `set_neural_lab_mode` / `bypass_neural_insert`. `test_neural_commands` (`[neural]`, 20 assertions): UI 100 → clamp 0.7, UI 50 → 0.35, **Lab unlock → 1.0**, re-lock → 0.7, bypass.
- [~] **GATE:** ASTD clamps + Lab unlock via commands ✅ (Windows). **Remaining (macOS):** NAM tone + RAVE morph audible; **PDC null test (no drift)** with a latency-introducing model; bypass-correct (the known inverted-logic bug); no dropouts.

### Stage 5 — Generative layer (`05`) — Fake first, then SA3 — *orchestration spine proven (out of order, since Stage 2/4 are platform-blocked here)*
- [x] `GenerativeModelAdapter` interface + **`FakeAdapter`** (deterministic placeholder) + `RenderCache` + the `renderLayer` orchestrator (`src/spine/Generative.h`). **Tested (25 assertions): cache HIT/MISS keyed by the FULL fingerprint, any-input-change → dirty → re-render, deterministic-per-fingerprint output, accept/reject taste labels.** Pure spine — no MLX/service/UI. Job service (Python submit/status/progress/cancel) + Tracktion-take landing are the next increment.
- [x] Job service + **C++↔service loop — DONE + verified end-to-end on Windows**. Python `service/` (stdlib: `POST/GET/DELETE /jobs`, deterministic placeholder WAV+manifest keyed by `cacheKey`, cooperative cancel, 404). C++ `GenerativeJobManager` (spine; spawns the service, `/health` handshake, submit/poll/cancel over HTTP, reads manifest) + `renderLayerViaService()`. `mosh_service_tests` (16 assertions): submit → poll progress → manifest WAV → cache; **cache HIT** on same fingerprint, **dirty → MISS** on changed seed. Lifecycle (heartbeat/crash-restart/cancel-on-close) still to harden.
- [x] RenderLayer flow + full cache fingerprint **driven via the command surface** (`src/spine/GenerativeCommands.{h,cpp}`): `create_render_layer`/`set_render_param`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`. `test_generative_commands` (22 assertions): create → render (progress events + `layer_rendered`, cache MISS) → same fingerprint → HIT (adapter not called) → seed change → dirty → MISS → re-render → **accept/reject captured as JSONL taste labels**. `bypass_layer`/`freeze_layer`/`bounce_layer_to_clip` are engine/take-bound — pending.
- [x] **PC BUILD — real CUDA `StableAudio3Adapter` DONE + verified from the UI** (the user's pivot from MLX). `service/adapters/stable_audio3_adapter.py` wraps the locally-installed CUDA Stable Audio 3 (`stable_audio_3` in the ComfyUI venv, model at `E:\comfy4_models\unet`): **generate** (text→audio) + **reimagine** (audio-to-audio via SA3 `init_audio`+`init_noise_level≤0.5`), per-step progress + cooperative cancel, 24-bit stereo WAV, env-var paths (`MOSH_SA3_MODEL_DIR`), selected by `MOSH_ADAPTER=stable_audio_3` + launched in the venv (`MOSH_SERVICE_PYTHON`). Required the **async render pool** (`src/spine/AsyncRenderPool`) so the slow model never freezes the UI, a **concurrent HttpBridge** (thread pool) so a real browser can drive it, and **Windows audio**. Verified from the browser: generate ~5 s / reimagine ~1 s, real audio, non-destructive accept. See STATUS "PC BUILD". **Now also DONE (COLORRACK arrived):** real activation-steering colors + init-latent cache + judge readout — see the next gate + STATUS "DEFERRED GENERATIVE ITEMS — COMPLETED".
- [x] **Engine landing VERIFIED on real Tracktion** (`mosh_engine` `GenerativeEngine` + `test_generative_engine`, `[gengine]`): RenderLayer attached under the source clip → `render_layer` via the **job service** → `accept_render` lands the result **NON-DESTRUCTIVELY as a new clip on a Neural lane** (source clip untouched) → **undo reverts the landing** → JSONL taste label. `bypass_layer`/`freeze_layer`/`bounce_layer_to_clip` + the take-based landing variant (per `neural_render_landing`) still to add.
- [x] **GATE (Fake) — now also driven FROM THE UI over HTTP (Windows-verified).** The generative commands are wired into the app (`Main.cpp`: `GenerativeJobManager`+`RenderCache`+`registerGenerativeEngineCommands`), render layers are surfaced in the snapshot (`EngineSnapshot` → `track.renderLayers[]`), and the UI drives the loop: per-clip **✦** → `create_render_layer`+`render_layer` (real Python service, FakeAdapter) → badge **"reimagine · ready"** → **✓** `accept_render` lands a new clip on a **"Neural" lane with the source UNTOUCHED** (non-destructive) / **✕** `reject_render`. **Cache MISS ~3.3 s, HIT ~0.3 s** vs the full fingerprint, in-app over HTTP. Plus the five backend levels (spine / service / C++↔service / command-surface / real-Tracktion engine + undo + JSONL taste labels). **Remaining:** `render_layer` is synchronous (no live progress; blocks the single-threaded bridge ~3 s — a background-job + "no playback stall" hardening pass, best with audio on macOS).
- [x] **GATE (SA3) — MET against the real CUDA model** (`service/scripts/sa3_e2e.py`, 7/7): real `grit` re-imagine via **real activation steering** (COLORRACK → forward hooks on the DiT; `grit@80`→α 0.18, `air@70`→α 0.032, exact ASTD math) lands as a non-destructive Neural-lane clip with a **quality readout** (`pq`/`pqBase`/Δ + flags in the manifest+snapshot+badge); **`get_colors`** drives the Color Rack knobs + ASTD ceilings; **Lab** unlocks α past the clamp; **init-latent cache `hit` on seed-only change** (MISS→HIT confirmed). Per-color value + Lab are in the full fingerprint (slider move re-renders; 2 new `[fingerprint]` tests). UI Color Rack popover + quality badge shipped (`ui/src/components/Timeline.tsx`). Suite **338/47 green** (Fake default). *Live-app from-the-UI drive over HTTP.*
- [x] **FOLLOW-UPS DONE + verified (see STATUS "FOLLOW-UPS"):** (1) **SA3 model on the SSD** — load 228 s (HDD) → 84–146 s (SSD). (2) **App-mode UI window** (`MOSH_UI_MODE=app`, Windows default) — a frameless Edge/Chrome `--app` window owned by Mosh (verified `uiConnected=True`); the embedded WebView2 stays blank on JUCE-8.0.8/Windows even after a deferred-nav retry, so `webview` now falls back to the app-mode window. (3) **Learned judge** (`MOSH_JUDGE=learned`) — Meta **Audiobox-Aesthetics** via a producer-lab sidecar gives the real `pq` (+ the 4 axes) while keeping the DSP flags; CPU by default (no VRAM contention); DSP stays default. Verified live: manifest `judge=audiobox`, `pq=5.82`, `pqBase`/Δ, steering intact.

### Stage 6 — Consolidation (`03`,`04`,`05`) — *producer COMMAND loop verified end-to-end over real Tracktion+service; "from the UI" render + audio export need macOS*
- [x] **Full producer command loop VERIFIED** (`test_producer_loop`, `[producer]`, 25 assertions, over real Tracktion + the real Python service): import (`create_track`+`import_clip`) → arrange (`move_clip`) → host plugin (`load_plugin`) → Tier-A neural (`add_neural_insert`+`set_neural_param` ASTD) → generative transform (`create_render_layer`+`render_layer` via service) → **accept (non-destructive landing, source untouched)** → mix (`set_track_gain`) → **undo/redo correct throughout** (undo mix, undo accept→reverts, redo→restores; full unwind→initial, full rebuild) → **export/persist** (saveAs→fresh reload→restored) → JSONL taste label. Uses the EXACT commands the (browser-verified) UI emits.
- [ ] Mixer polish; two-theme system; reserved B-5 slot; optional prompt-concision rewriter + quality readout (cosmetic v0 adds).
- [~] **GATE:** producer loop + **undo/redo correct throughout** ✅ via the command surface (real Tracktion+service) AND ✅ **the arrange/transport/undo-redo portion now driven literally from the UI** (a real browser over the HttpBridge → real Tracktion; see STATUS "BREAKTHROUGH"). **Remaining (macOS):** the *in-app* JUCE WebView render (WKWebView) + the audio-output/VST3-editor/anira/MLX legs + **audio export** (audio device). Suite total: **326 assertions / 44 cases** across 3 test exes.

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
