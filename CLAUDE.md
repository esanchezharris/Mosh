# CLAUDE.md — Mosh Run Manifest

*Flat, tick-through checklist for the autonomous build. Collapses the gates and `// VERIFY` items from specs `00`–`06`. Place at repo root so Claude Code auto-loads it. Specs are the source of truth for **how**; this file is the source of truth for **what's done / what's next**.*

> **New to the repo? Read [ARCHITECTURE.md](ARCHITECTURE.md) first** — the 2-minute map of what Mosh is (native app + WebView UI + native engine), where each module lives, and what the app can actually do. This manifest is just build status.

**Spec set:** `00_MOSH_MASTER_SPEC.md` (start) → `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` → **`02`** (lives at [`docs/02_MOSHOPS_CONTRACT.md`](docs/02_MOSHOPS_CONTRACT.md), reconstructed) → *(no standalone `03` — the WebView UI is covered by [ARCHITECTURE.md](ARCHITECTURE.md))* → `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` → `05_GENERATIVE_LAYER.md` → `06_BUILD_TOOLING_AND_RUN_PLAN.md`. `07_DEFERRED_AND_MODEL_NOTES.md` is context/parking-lot (model landscape, deferred lanes, license posture) — not build work.

---

## Prime directives (never violate)

- [x] **One mutation path:** every user-visible change is a **MoshOps command** (validate → Tracktion undo transaction → emit events → JSONL line → structured result). UI/agent never mutate Tracktion directly.
- [x] **One undo system:** Tracktion's `UndoManager` is the undo *implementation* under MoshOps. No second UndoManager, no shadow model.
- [x] **Swappable seam:** the frontend couples to the backend **only** via `execute_command(...)` + the **snapshot+events** feed. No Tracktion/audio concepts in the frontend. Pure view state (drawers, zoom, scroll, selection) is UI-local and **not** a command. (Stage 2 swappability proof: rebuilt bundle, byte-identical backend.)
- [x] **Tier wall:** Tier A in-process (custom `te::Plugin`); Tier B (generative) is a **job via the adapter/service**. No generative model in anira; **no real-time sidecar**. (NB: v0 Tier-A ships a self-contained RT-safe MLP; anira-pool is gated for RAVE/DDSP.)
- [x] **Threading:** model + bridge on the message thread; audio in `applyToBuffer` on RT threads (no alloc); service-I/O on background (`std::thread` + `callAsync`); **audio thread never blocks**; telemetry decimated 30 Hz.
- [x] **ASTD everywhere, defeatable:** every over-driveable neural param is a 0–100 UI control clamped below quality-collapse; **Lab mode** unlocks the raw range. One shared impl (`mosh::astd`), both tiers.
- [x] **Cache by full fingerprint:** Tier-B reuse keyed by the complete fingerprint (`05 §5`), never just source+params. (Harness: HIT/MISS verified.)
- [x] **FakeAdapter before SA3:** generative orchestration proven with the stub (81/81); SA3 swaps in last (deferred/gated).
- [x] **VERIFY before relying:** resolved against the **pinned `tracktion_engine` clone** (`2877b621`); documented file-based fallbacks taken (new-clip landing, render-to-file). See `docs/ENGINE_API_NOTES.md`.
- [x] **macOS / Apple Silicon (arm64) ONLY for v0.** No Windows/Linux/CUDA paths.
- [x] **Gate discipline:** never advanced past a failing gate; reported against concrete gates (all six PASSED).
- [x] **Always leave an artifact:** `docs/PROGRESS.md` + per-gate commits + this manifest kept current.

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
- [x] **`StableAudio3Adapter`** ✅ — the REAL model, carved into `service/sa3/engine.py` (in-process MLX SA3-medium, ~1.7s load, ~1.5s/render), `service/adapters/stable_audio3_adapter.py`, `service/sa3/init_cache.py` (VAE init-latent cache), `service/sa3/qa.py`+`_pq_worker.py` (Audiobox `pq` via the judges venv). Colours: `service/colors/build_colorrack.py` → `COLORRACK_DATA` (9 validated colours: brightness/epic/distortion/futuristic/tension + grit + air[cap 0.08] + heroes drum_aggression/grid_tightness), `colors/runtime.py` (0–100→α ASTD clamp, Lab unlock, ≤3 compose w/ 0.25/0.20 backoff, no-stack rejection). `server.py` dispatches adapters via a single serialized priority worker (MLX isn't concurrent); `/colors` endpoint; `run.sh` runs under the MLX venv when `MOSH_ENABLE_SA3=1`. Two hardcoded paths → env (`SA3_MLX_DIR`, `COLORRACK_DATA`). Graceful downgrade → FakeAdapter when SA3 absent.
- [x] **GATE (Fake):** full loop via commands — render → audition (cached artifact) → accept/reject; **cache HIT/MISS vs full fingerprint**; param change → dirty → re-render (MISS); JSONL logs accept/reject as **taste labels**; async/background render (no playback stall). Proven by `Mosh --selftest` (81/81) + `Mosh --demo5` generative-drawer screenshot.
- [x] **GATE (SA3):** ✅ PASSED (2026-06-08) — real **re-imagine** with a `grit` colour commits as an auditionable render with a quality readout; `/colors` drives the ASTD-clamped rack (air shows "CAPPED"); Lab unlocks; **init-latent cache hits on identical re-render**; full-fingerprint cache HIT/MISS (incl. SA3 service build). Proven by `Mosh --selftest` **98/98** (SA3-gated path) + standalone HTTP smoke (pq 5.10/pq_base 5.66 → `quality_degraded`) + `Mosh --demo5` SA3 colour-rack screenshot. FakeAdapter-only still green (graceful degradation). *(98/98 and 89/89 are the original 2026-06-08 gate counts; the harness has since grown — the default `--selftest` is now **784 checks**.)*

### Stage 6 — Consolidation (`03`,`04`,`05`) ✅ GATE PASSED (2026-06-08)
- [x] Mixer (in track headers: volume/pan/mute/solo); **two-theme system** (shared CSS tokens, dark/light toggle); **reserved B-5 slot** (empty placeholder in the topbar); quality readout via the FakeAdapter manifest (`pq`/`pq_base`/`flags`). `export_audio` command (synchronous `Renderer::renderToFile`).
- [x] **GATE:** full producer loop — import (`add_test_tone_clip`) → arrange (`move`/`trim`) → host VST3 (`load_plugin`) → Tier-A insert (`add_neural_insert`) → generative transform (`create`/`render`/`accept_render`) → mix (`set_track_volume`) → **export** (794KB WAV of the whole signal chain) → undo/redo correct. Proven by `Mosh --selftest` (89/89 at the 2026-06-08 gate; the harness is now **784 deterministic checks**) + `Mosh --demo6` consolidated-UI screenshot (both neural tiers on one track, export + theme + B-5 in the topbar).

Build the arrangement incrementally within Stage 2/6: static clips → drag/move → trim/split → zoom/snap → marquee.

---

## API resolutions & open questions

All `// VERIFY` items from specs `00`–`06` were resolved against the pinned `tracktion_engine` clone (`2877b621`). **Exact signatures + the file-based fallbacks taken (new-clip landing, `renderToFile`, peak-array waveforms, the latency delay-line) live in [`docs/ENGINE_API_NOTES.md`](docs/ENGINE_API_NOTES.md);** the runtime shape is summarized in [ARCHITECTURE.md](ARCHITECTURE.md) §3.

Design micro-questions settled by the shipped implementation: `MOSH_RENDERLAYER` is **clip-parented**; undo/redo and structural changes resync via **`snapshot_invalidated`** (not inverse-deltas); selection is **UI-local** (commands carry explicit target args — no mirrored backend selection). Still gated: anira `InferenceHandler` (RAVE/DDSP) — v0 ships the inline RT-safe MLP; SA3 carve-out paths are env-driven (`SA3_MLX_DIR`, `COLORRACK_DATA`, `MOSH_JUDGES_PY`).

---

## Working notes

- **macOS / Apple Silicon (arm64) only** (matches the MLX service). Unified-memory zero-copy is the load-bearing neural advantage; no cross-platform code paths in v0.
- **Spine first:** MoshOps + snapshot/events is the highest-leverage early work — UI and both neural tiers are clients of it.
- **The swappability gate (Stage 2)** is non-negotiable: rebuild the React bundle, zero backend change.
- **FakeAdapter before SA3** (Stage 5) — prove orchestration with the stub.
- The **arrange view** is incremental, not a from-scratch native renderer (it's React over the `02` contract) — lower risk than the prior plan, but still stage it.
- Optional non-blocking adds once core works: prompt-concision rewriter (`05 §6`), judge-panel quality readout (`05 §7`), `StableAudioOpenSmallAdapter` bring-up rung (`05 §2`).
- **Type-beat LoRA trainer — scaffold landed (post-v0, 2026-06-18).** The rights-cleared *scaffold* shipped on `main`: a rights registry + eligibility gate, a deterministic SHA256 corpus bundler, and job orchestration (`src/training/`, `service/training/`, 10 additive non-undoable `MoshOps` commands, `/training/*` service routes), behind a **fake** training backend and a WIP `LoRA` topbar popover (no progress/error UI yet). The REAL on-device LoRA training backend + vector layering stay deferred (below).
- Deferred (do **not** build): B-5/operator behavior + multiplayer/CRDT op-log; on-device SAO-Small + Medium→Small transfer; the **real** on-device LoRA-base training + vector layering (the trainer *scaffold* + fake backend already landed — see above); timestep-scheduled steering; full Context-Drawers system; **MRT2 live generative-instrument lane** (more viable now we're Mac-only, but not core v0 — `07`); foleys/cello/Gin/JUMP (only if a later need appears).
