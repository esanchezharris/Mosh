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

### Stage 1 — Engine + MoshOps + state feed (`01`,`02`) ✅ GATE PASSED (2026-06-08)
- [x] `Engine` constructed once (`MoshEngine`); device init (`getDeviceManager().initialise()`); `Edit` via `createEmptyEdit`/`loadEditFromFile`; `edit.getUndoManager()` is the undo impl under MoshOps. Session persists at `~/Library/Mosh/session/`.
- [x] MoshOps `execute()` with result envelope + validation + per-command Tracktion transaction (`beginNewTransaction`) + JSONL log (`mosh-log.jsonl`). Reconstructed missing spec 02 → `docs/02_MOSHOPS_CONTRACT.md`.
- [x] `snapshot()` + typed event stream on `"mosh_event"` channel (snapshot_invalidated + 30 Hz decimated transport); commands: `create_track`, `rename_track`, `remove_track`, `import_clip`, `add_test_tone_clip`, `set_transport`, `undo`, `redo`, `save`, `reload`, `add_render_layer`.
- [x] `MOSH_RENDERLAYER` schema defined (`src/state/`) + full cache fingerprint (route/variant/seed-sensitive); Catch2 round-trip + fingerprint tests pass.
- [x] **GATE:** WebView renders a snapshot cold (empty + loaded session, screenshot-verified); `create_track`+`import_clip` via MoshOps; transport play allocates playback context; scrub/seek; undo/redo via MoshOps; JSONL records commands; save/reload restores. **Proven by the command-surface harness `Mosh --selftest` → 34/34 checks pass** (06 §4) + live WebView render + `ping()`/`get_snapshot()` bridge round-trips. (Synthetic UI clicks blocked by macOS Accessibility perms — not a product gap; same execute path as the verified `get_snapshot`.)

### Stage 2 — WebView arrangement (`03`) ✅ GATE PASSED (2026-06-08)
- [x] Conventional layout: track headers (name/remove + mixer M·S·volume), timeline lanes, clips, transport bar, mixer stub (in-header volume/pan/mute/solo).
- [x] Playhead via **decimated** 30 Hz transport events; waveforms from backend **peak arrays** (`get_clip_peaks` → canvas; no audio on web thread). Real audio level meters deferred to Stage 6 (no public level-tap on `VolumeAndPanPlugin`; playhead decimation path proven).
- [x] All mutation via MoshOps; clip drag→`move_clip`, edge-trim→`trim_clip`, split-tool→`split_clip`; mixer→`set_track_volume/pan/mute/solo`. Incremental: static→drag→trim→split→zoom→snap→marquee all implemented.
- [x] **GATE:** full interactive arrangement built (drag-move w/ optimistic preview, trim handles, split tool, zoom, snap-to-grid, marquee select, ruler seek + shift-drag loop region). **Swappability PROVEN:** rebuilt the React bundle (visible marker) and re-staged into the running app — C++ binary **byte-identical** (sha256 `3e49448f…` before/after), app still works. Command surface proven by `Mosh --selftest` (47/47). (Live drag not synthetically clickable — macOS Accessibility perms — but the UI uses the same verified `executeCommand` path as the live-proven `get_snapshot`/`get_clip_peaks`.)

### Stage 3 — VST3 hosting via commands (`04`) ✅ GATE PASSED (2026-06-08)
- [x] `list_plugins`/`load_plugin`/`remove_plugin`/`reorder_plugin`/`set_plugin_param`/`bypass_plugin`/`open_plugin_editor` + `add_midi_clip`; native editor pop-out (`PluginHost` + `EditorWindow`). UI: per-track plugin Rack (bypass/edit/reorder/remove) + modal plugin browser; track-header selection. `JUCE_PLUGINHOST_VST3/AU=1`.
- [x] **GATE:** **VST3 synth (Vital) from a MIDI clip + VST3 effect (OTT) on a wave clip, all via MoshOps commands; native editor opens** (screenshot-verified — Vital's full editor popped out); persists across save/reload. Proven by `Mosh --selftest` (60/60: load/remove/reorder/param/bypass/persist for effect+instrument, MIDI clip) + `Mosh --demo3` visual. **Key fix:** plugins added to `pluginList` MUST be created via `edit.getPluginCache().createNewPlugin(type, desc)` (not `PluginManager::createNewPlugin`) or `indexOf` fails + it asserts.

### Stage 4 — Tier-A real-time neural (`04`) ✅ GATE PASSED (2026-06-08)
- [x] `NeuralInsertPlugin` (custom `te::Plugin`) registered via `createBuiltInType<>()`; RT-safe `applyToBuffer` (preallocated MLP + delay line, no alloc); warm-up in `initialise()`. Self-contained genuine 2-layer tanh MLP waveshaper as the inline (NAM/Proteus-class) model; **model-agnostic host** (RTNeural captures / anira-pooled RAVE+DDSP are pinned + gated behind `MOSH_ENABLE_RTNEURAL`/`MOSH_ENABLE_ANIRA`).
- [x] NAM/Proteus-class inline model **ships**; RAVE/DDSP (anira+LibTorch, heavy) **gated**; per-(model,param) ASTD ranges. dry/wet + model reset baked into the host (§2.7).
- [x] `getLatencySeconds()` returns the **true** delay (internal delay line of exactly the reported length); knobs via `add_neural_insert`/`set_neural_param` (0–100 UI, ASTD-mapped); `set_neural_lab_mode`/`set_neural_latency`/`reset_neural`. UI: neural rack card with ASTD sliders (safe-max marker), Lab toggle, reset, latency.
- [x] **GATE:** **PDC null test passes** (impulse emerges at *exactly* the reported latency → no drift); **bypass correct** (passthrough, latency constant on bypass — guards the inverted-logic bug); RT-safe (no dropouts by design); ASTD clamps hold + Lab unlock — all via commands. Proven by `Mosh --selftest` (69/69) + Catch2 ASTD unit tests + `Mosh --demo4` visual (neural rack, screenshot). **Honest gap:** real inference verified (driven signal altered, silence silent), but specific NAM/RAVE *audible A/B* not done (no model files, no ears, CoreAudio HAL wedged this session) — RAVE-via-anira is the gated next rung.

### Stage 5 — Generative layer (`05`) — Fake first, then SA3 ✅ FAKE GATE PASSED (2026-06-08)
- [x] `GenerativeModelAdapter` shape + **`FakeAdapter`** (Python `service/adapters/fake_adapter.py`) — deterministic, recognizably-altered audio (seeded gain + one-pole LP + saturation), stdlib `wave` only.
- [x] Job service (`service/server.py`): submit/status/progress/cancel + capabilities/health; audio over files+manifests (`input.wav`/`output.wav`/`output_manifest.json`). Native `GenerativeJobManager` (`src/generative/`): HTTP via `juce::URL`, spawns/detects the service (`juce::ChildProcess`), health handshake, cancel-on-close.
- [x] RenderLayer flow + full cache fingerprint (MD5 upstream hash · route · variant · seed · params · safetyMappingVersion · service build); commands `create_render_layer`/`set_render_param`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`/`bypass_layer`/`freeze_layer`/`bounce_layer_to_clip`. Landing = new-clip-on-"Neural Renders"-lane (the documented guaranteed fallback). UI: generative drawer (grit/nl ASTD sliders, status, render/accept/reject/seed).
- [ ] **`StableAudio3Adapter`** — DEFERRED/gated (no local MLX SA3 model this session; same posture as RAVE). Architecture ready (model-neutral adapter + job protocol; env-var paths `SA3_MLX_DIR`/`COLORRACK_DATA` reserved).
- [x] **GATE (Fake):** full loop via commands — render → audition (cached artifact) → accept/reject; **cache HIT/MISS vs full fingerprint**; param change → dirty → re-render (MISS); JSONL logs accept/reject as **taste labels**; async/background render (no playback stall). Proven by `Mosh --selftest` (81/81) + `Mosh --demo5` generative-drawer screenshot.
- [ ] **GATE (SA3):** DEFERRED — needs the external MLX SA3 stack (not present this session).

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
- [x] Waveform delivery — RESOLVED: peak array per clip via `get_clip_peaks` (backend reads source WAV, min/max per bucket) → `<canvas>` in the UI. No audio on the web thread.

**Plugins / Tier A (`04`)**
- [x] `ExternalPlugin` editor-window accessor. RESOLVED: `ExternalPlugin::getAudioPluginInstance()` → `createEditorIfNeeded()` / `GenericAudioProcessorEditor`; `te::Plugin::EditorComponent` + `PluginWindowState` (see `examples/common/PluginWindow.h`).
- [x] `LatencyPlugin` latency pattern — RESOLVED + implemented: `getLatencySeconds()` returns `latencySamples/sampleRate`; an internal delay line of exactly that length applied to the output (even on bypass → constant latency). PDC null test confirms the impulse emerges at exactly the reported latency (no drift).
- [ ] anira `InferenceHandler::process`/`prepare` — DEFERRED (anira gated; v0 uses a self-contained RT-safe MLP). Resolve when `MOSH_ENABLE_ANIRA` is turned on for RAVE/DDSP.
- [x] NAM/Proteus inline vs via anira — DECIDED: inline (self-contained MLP, zero-latency, RT-safe, no heavy backend) ships; anira's pool reserved for RAVE/DDSP.
- [x] Bypassed-plugin PDC (forum #53709) — TESTED: bypass passes audio through unchanged and keeps latency constant (delay applied regardless of `isEnabled`), so PDC stays correct across bypass toggles.

**Generative (`05`)**
- [x] Takes/comp add+promote — RESOLVED via the **new-clip-on-neural-lane fallback** (05 §3.1): `accept_render` lands the output as a `WaveAudioClip` on a "Neural Renders" lane, lineage via the RenderLayer link. (Take-injection into a clip stays a later enhancement.)
- [x] `Renderer::Parameters` fields + `renderToFile` — RESOLVED: `{engine, tracksToDo (BigInteger), allowedClips, destFile, audioFormat, bitDepth, sampleRateForAudio, time (TimeRange), realTimeRender}`; `Renderer::renderToFile(desc, Parameters)`. v0 stages a wave clip's source directly (equivalent for no-upstream-FX); `renderToFile` is the general path.
- [x] Render-to-file (preferred) vs -to-buffer — chose **file-based** (the input.wav/output.wav/manifest job protocol).
- [ ] SA3 carve-out external deps + two hardcoded paths (App. B) — DEFERRED with the SA3 adapter (env vars `SA3_MLX_DIR`/`COLORRACK_DATA` reserved).

---

## Working notes

- **macOS / Apple Silicon (arm64) only** (matches the MLX service). Unified-memory zero-copy is the load-bearing neural advantage; no cross-platform code paths in v0.
- **Spine first:** MoshOps + snapshot/events is the highest-leverage early work — UI and both neural tiers are clients of it.
- **The swappability gate (Stage 2)** is non-negotiable: rebuild the React bundle, zero backend change.
- **FakeAdapter before SA3** (Stage 5) — prove orchestration with the stub.
- The **arrange view** is incremental, not a from-scratch native renderer (it's React over the `02` contract) — lower risk than the prior plan, but still stage it.
- Optional non-blocking adds once core works: prompt-concision rewriter (`05 §6`), judge-panel quality readout (`05 §7`), `StableAudioOpenSmallAdapter` bring-up rung (`05 §2`).
- Deferred (do **not** build): B-5/operator behavior + multiplayer/CRDT op-log; on-device SAO-Small + Medium→Small transfer; LoRA-base + vector layering; timestep-scheduled steering; full Context-Drawers system; **MRT2 live generative-instrument lane** (more viable now we're Mac-only, but not core v0 — `07`); foleys/cello/Gin/JUMP (only if a later need appears).
