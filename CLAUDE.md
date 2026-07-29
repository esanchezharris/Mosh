# CLAUDE.md — Mosh Run Manifest

*Flat, tick-through checklist for the autonomous build. Collapses the gates and `// VERIFY` items from specs `00`–`06`. Place at repo root so Claude Code auto-loads it. Specs are the source of truth for **how**; this file is the source of truth for **what's done / what's next**.*

> **New to the repo? Read [ARCHITECTURE.md](ARCHITECTURE.md) first** — the 2-minute map of what Mosh is (native app + WebView UI + native engine), where each module lives, and what the app can actually do. This manifest is just build status.

**Spec set:** `00_MOSH_MASTER_SPEC.md` (start) → `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` → **`02`** (lives at [`docs/02_MOSHOPS_CONTRACT.md`](docs/02_MOSHOPS_CONTRACT.md), reconstructed) → *(no standalone `03` — the WebView UI is covered by [ARCHITECTURE.md](ARCHITECTURE.md))* → `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` → `05_GENERATIVE_LAYER.md` → `06_BUILD_TOOLING_AND_RUN_PLAN.md`. `07_DEFERRED_AND_MODEL_NOTES.md` is context/parking-lot (model landscape, deferred lanes, license posture) — not build work.

---

## Prime directives (never violate)

- [x] **One mutation path:** every user-visible change is a **MoshOps command** (validate → Tracktion undo transaction → emit events → JSONL line → structured result). UI/agent never mutate Tracktion directly.
- [x] **One undo system:** Tracktion's `UndoManager` is the undo *implementation* under MoshOps. No second UndoManager, no shadow model.
- [x] **Swappable seam:** the frontend couples to the backend **only** via `execute_command(...)` + the **snapshot+events** feed. No Tracktion/audio concepts in the frontend. Pure view state (drawers, zoom, scroll, selection) is UI-local and **not** a command. (Stage 2 swappability proof: rebuilt bundle, byte-identical backend.)
- [x] **Tier wall:** the generative model runs **only** as a **job via the adapter/service** (Tier B) — never on the audio thread. *(The synthetic Tier-A in-process insert was removed 2026-06-21. **Correction:** this directive used to read "no real-time sidecar" full stop, which the code contradicts — `RaveInsertPlugin` (Route C.2) IS a real-time neural insert, running a RAVE model live via anira+LibTorch. It is legitimate because it is **build-gated OFF by default** (`MOSH_ENABLE_ANIRA`), so the default binary is byte-unaffected and the tier wall holds for every shipped build. The rule is "no real-time model in the default build", not "no real-time model exists".)*
- [x] **Everything is reachable by mouse:** every command in the agent catalog has a control a mouse-only producer can reach from the **shipped v2 shell** — no keyboard-only, agent-only, or classic-only affordances. Enforced by `ui/src/agent/uiReachability.test.ts`, which walks the module graph from `AppV2.tsx` and now asserts `UI_REACH_GAPS` is **exactly 0** (16 → 0 on 2026-07-26). Two consequences worth knowing before you add a command: the probe is a string search, so a module v2 imports for *helpers* but never renders must be declared in `CLASSIC_ONLY_MODULES` or it makes its whole subtree look reachable (that false positive hid the fact that a v2 user could not delete a track); and an exception with a written reason is still an exception — several long-standing entries turned out to describe an assumption rather than the code. [Close-out](docs/worklog/2026-07-26-ui-reach-closed-16-to-0-freeze-was-inert-bounce-had-no-surface.md).
- [x] **Threading:** model + bridge on the message thread; audio in `applyToBuffer` on RT threads (no alloc); service-I/O on background (`std::thread` + `callAsync`); **audio thread never blocks**; telemetry decimated 30 Hz.
- [x] **ASTD everywhere, defeatable:** every over-driveable generative param is a 0–100 UI control clamped below quality-collapse; **Lab mode** unlocks the raw range. Implemented in the Tier-B service (`service/colors/runtime.py`). *(The C++ `mosh::astd` impl was removed with the Tier-A insert, 2026-06-21.)*
- [x] **Cache by full fingerprint:** Tier-B reuse keyed by the complete fingerprint (`05 §5`), never just source+params. (Harness: HIT/MISS verified.)
- [x] **FakeAdapter before SA3:** generative orchestration proven with the stub (81/81); SA3 swaps in last (deferred/gated).
- [x] **VERIFY before relying:** resolved against the **pinned `tracktion_engine` clone** (`2877b621`); documented file-based fallbacks taken (new-clip landing, render-to-file). See `docs/ENGINE_API_NOTES.md`.
- [x] **macOS / Apple Silicon (arm64) + MLX is canonical; Windows + NVIDIA/CUDA is an additive port.** *(Refined 2026-07-27: arm64 is still canonical — it is the only arch with MLX — but it is no longer the only **Mac** target. What ships is a **Universal 2** `Mosh.app` (`macos-universal-release`), so Intel Macs run natively; the dev loop and the native gate stay arm64 for speed. On Intel the generative tier degrades to the preview engine, which the drawer's amber badge states honestly — enforced by `service/sa3/engine.py`'s MLX-importability check, not just a directory stat. Two traps live here: `CMAKE_OSX_DEPLOYMENT_TARGET` **must** stay above `project()` or it is a silent no-op — that bug shipped a `minos 26.0` app against a documented "macOS 11+" promise — and `run-mosh.sh`'s `resolve_app()` searches only arm64 build dirs, so calling it after a universal build hands back a stale arm64 bundle that signs and notarizes fine and cannot launch on Intel. Both are caught fail-closed by `scripts/release/assert-universal.sh`, which every packaging path runs. See [docs/MACOS_INTEL.md](docs/MACOS_INTEL.md).)* Every platform fork is `#if`/`if(WIN32)`-guarded so the macOS path stays behaviour-equivalent (proven: the macOS `--selftest` passes unchanged after the port). The generative tier swaps MLX→PyTorch/CUDA behind the same adapter contract. **Linux (x86_64) is an exploratory spike** (FIT-011): the headless `MoshTests` target + the cross-platform Python service build and are CI-tracked on `ubuntu-latest` (`.github/workflows/linux-ci.yml`); the full GUI app (WebKitGTK webview + ALSA audio + JUCE Linux VST3 hosting) is compiled informationally in CI but is **not yet a supported target**. This Mac (arm64 macOS) can't build for Linux, so the config is only statically checked here — the first CI run is the real verdict. See `docs/2026-07-07-linux-build-spike.md`.
- [x] **Gate discipline:** never advanced past a failing gate; reported against concrete gates (all six PASSED).
- [x] **Always leave an artifact:** a `docs/worklog/` note + per-gate commits + this manifest kept current. *(`docs/PROGRESS.md` retired 2026-07-28 — history only.)*

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
- [x] Playhead via **decimated** 30 Hz transport events; waveforms from backend **peak arrays** (`get_clip_peaks` → canvas; no audio on web thread). ~~Real audio level meters deferred to Stage 6 (no public level-tap on `VolumeAndPanPlugin`; playhead decimation path proven).~~ **Corrected:** per-track + master dB metering shipped in **Wave 9** (2026-06-09, `5138628f`; polished `4a77257d`) — `VolumeAndPanPlugin` itself indeed exposes no measurer (that part was true), so `MoshOps::ensureTrackMeter` inserts a dedicated `te::LevelMeterPlugin` **post-fader** per track (hidden from the `plugins` rack array, real index preserved) instead; levels are emitted on the same 30 Hz rail as transport, on a separate `"levels"` event (`{tracks:[{id,l,r}], master:{l,r}}`), and consumed via `store.levels` — deliberately **outside** the snapshot, same discipline as `store.transport`. `Meter`/`MasterMeter` (`ui/src/ui/Meter.tsx`) render it in the classic shell; the v2 shell got its own `TrackMeterBar` + a `RightRail` master-level readout in the [METER-001 pass](docs/worklog/2026-07-18-meter-001-v2-track-master-level-meters-a-real-coverage-bug-f.md).
- [x] All mutation via MoshOps; clip drag→`move_clip`, edge-trim→`trim_clip`, split-tool→`split_clip`; mixer→`set_track_volume/pan/mute/solo`. Incremental: static→drag→trim→split→zoom→snap→marquee all implemented.
- [x] **GATE:** full interactive arrangement built (drag-move w/ optimistic preview, trim handles, split tool, zoom, snap-to-grid, marquee select, ruler seek + shift-drag loop region). **Swappability PROVEN:** rebuilt the React bundle (visible marker) and re-staged into the running app — C++ binary **byte-identical** (sha256 `3e49448f…` before/after), app still works. Command surface proven by `Mosh --selftest` (47/47). (Live drag not synthetically clickable — macOS Accessibility perms — but the UI uses the same verified `executeCommand` path as the live-proven `get_snapshot`/`get_clip_peaks`.)

### Stage 3 — VST3 hosting via commands (`04`) ✅ GATE PASSED (2026-06-08)
- [x] `list_plugins`/`load_plugin`/`remove_plugin`/`reorder_plugin`/`set_plugin_param`/`bypass_plugin`/`open_plugin_editor` + `add_midi_clip`; native editor pop-out (`PluginHost` + `EditorWindow`). UI: per-track plugin Rack (bypass/edit/reorder/remove) + modal plugin browser; track-header selection. `JUCE_PLUGINHOST_VST3/AU=1`.
- [x] **GATE:** **VST3 synth (Vital) from a MIDI clip + VST3 effect (OTT) on a wave clip, all via MoshOps commands; native editor opens** (screenshot-verified — Vital's full editor popped out); persists across save/reload. Proven by `Mosh --selftest` (60/60: load/remove/reorder/param/bypass/persist for effect+instrument, MIDI clip) + `Mosh --demo3` visual. **Key fix:** plugins added to `pluginList` MUST be created via `edit.getPluginCache().createNewPlugin(type, desc)` (not `PluginManager::createNewPlugin`) or `indexOf` fails + it asserts.

### Stage 4 — Tier-A real-time neural (`04`) ✅ GATE PASSED (2026-06-08) · ⛔ REMOVED (2026-06-21)
- The synthetic Tier-A insert (`NeuralInsertPlugin`: a deterministic, **untrained** 2-layer tanh MLP waveshaper — a drive-conditioned **saturator**, not a real amp/transfer model) was **removed** in the layer-simplification pass. Rationale: it added a whole "tier" for an effect any saturation VST does better, and it could not reach the dramatic timbre/instrument-transfer demos (those need a RAVE/DDSP/MelodyFlow-class model — a different host shape). Removing it collapses the two-tier neural framing into a **single generative tier (Tier B)**.
- Went with it: the 6 neural commands (`add_neural_insert`/`set_neural_param`/`set_neural_lab_mode`/`set_neural_latency`/`reset_neural`/`load_neural_model`), the `MOSH_ENABLE_RTNEURAL`/`MOSH_ENABLE_ANIRA` build gates + `mosh_neural_backends` target, the UI neural rack card + agent-catalog entries, the `--neural-ab`/`--demo4` CLI modes, and `Astd.h` + `test_astd.cpp` (C++-orphaned — Tier-B's ASTD is Python). **Kept:** the spectral tap (Moshi reactivity) and the Tier-B "Neural Renders" lane (a different thing).
- Verified post-removal: `Mosh --selftest` **877/877 ×3** deterministic, Catch2 **160 assertions**, vitest **419**, e2e **38**, `tsc` clean. Dramatic transforms now come from hosting a VST3 (e.g. gary4juce `terry`/MelodyFlow) or a future Route-B (Tier-B transform adapter) / Route-C (real-time RAVE) build — see the plan in agent memory.

### Stage 5 — Generative layer (`05`) — Fake first, then SA3 ✅ FAKE GATE PASSED (2026-06-08)
- [x] `GenerativeModelAdapter` shape + **`FakeAdapter`** (Python `service/adapters/fake_adapter.py`) — deterministic, recognizably-altered audio (seeded gain + one-pole LP + saturation), stdlib `wave` only.
- [x] Job service (`service/server.py`): submit/status/progress/cancel + capabilities/health; audio over files+manifests (`input.wav`/`output.wav`/`output_manifest.json`). Native `GenerativeJobManager` (`src/generative/`): HTTP via `juce::URL`, spawns/detects the service (`juce::ChildProcess`), health handshake, cancel-on-close.
- [x] RenderLayer flow + full cache fingerprint (MD5 upstream hash · route · variant · seed · params · safetyMappingVersion · service build); commands `create_render_layer`/`set_render_param`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`/`bypass_layer`/`freeze_layer`/`unfreeze_layer`/`bounce_layer_to_clip`. Landing = new-clip-on-"Neural Renders"-lane (the documented guaranteed fallback) — still the path for a **section-scoped** render, which cannot apply in place; whole-clip wave and MIDI renders auto-apply (PR #185), which is why `bounce_layer_to_clip` is a pure relabel everywhere except a section. UI: generative drawer (grit/nl ASTD sliders, status, render/accept/reject/seed).
- [x] **`StableAudio3Adapter`** ✅ — the REAL model, carved into `service/sa3/engine.py` (in-process MLX SA3-medium, ~1.7s load, ~1.5s/render), `service/adapters/stable_audio3_adapter.py`, `service/sa3/init_cache.py` (VAE init-latent cache), `service/sa3/qa.py`+`_pq_worker.py` (Audiobox `pq` via the judges venv). Colours: `service/colors/build_colorrack.py` → `COLORRACK_DATA` (9 validated colours: brightness/epic/distortion/futuristic/tension + grit + air[cap 0.08] + heroes drum_aggression/grid_tightness), `colors/runtime.py` (0–100→α ASTD clamp, Lab unlock, ≤3 compose w/ 0.25/0.20 backoff, no-stack rejection). `server.py` dispatches adapters via a single serialized priority worker (MLX isn't concurrent); `/colors` endpoint; `run.sh` runs under the MLX venv when `MOSH_ENABLE_SA3=1`. Two hardcoded paths → env (`SA3_MLX_DIR`, `COLORRACK_DATA`). Graceful downgrade → FakeAdapter when SA3 absent.
- [x] **GATE (Fake):** full loop via commands — render → audition (cached artifact) → accept/reject; **cache HIT/MISS vs full fingerprint**; param change → dirty → re-render (MISS); JSONL logs accept/reject as **taste labels**; async/background render (no playback stall). Proven by `Mosh --selftest` (81/81) + `Mosh --demo5` generative-drawer screenshot.
- [x] **GATE (SA3):** ✅ PASSED (2026-06-08) — real **re-imagine** with a `grit` colour commits as an auditionable render with a quality readout; `/colors` drives the ASTD-clamped rack (air shows "CAPPED"); Lab unlocks; **init-latent cache hits on identical re-render**; full-fingerprint cache HIT/MISS (incl. SA3 service build). Proven by `Mosh --selftest` **98/98** (SA3-gated path) + standalone HTTP smoke (pq 5.10/pq_base 5.66 → `quality_degraded`) + `Mosh --demo5` SA3 colour-rack screenshot. FakeAdapter-only still green (graceful degradation). *(98/98 and 89/89 are the original 2026-06-08 gate counts; the harness has since grown — the default `--selftest` is now **≈1032 checks**, gate-dependent.)*

### Stage 6 — Consolidation (`03`,`04`,`05`) ✅ GATE PASSED (2026-06-08)
- [x] Mixer (in track headers: volume/pan/mute/solo); **two-theme system** (shared CSS tokens, dark/light toggle); **reserved B-5 slot** (empty placeholder in the topbar); quality readout via the FakeAdapter manifest (`pq`/`pq_base`/`flags`). `export_audio` command (synchronous `Renderer::renderToFile`).
- [x] **GATE:** full producer loop — import (`add_test_tone_clip`) → arrange (`move`/`trim`) → host VST3 (`load_plugin`) → ~~Tier-A insert (`add_neural_insert`)~~ *(that command was DELETED 2026-06-21 with the Tier-A insert; the loop is proven without it today)* → generative transform (`create`/`render`/`accept_render`) → mix (`set_track_volume`) → **export** (794KB WAV of the whole signal chain) → undo/redo correct. Proven by `Mosh --selftest` (89/89 at the 2026-06-08 gate; the harness is now **≈1032 deterministic checks**, gate-dependent) + `Mosh --demo6` consolidated-UI screenshot (both neural tiers on one track, export + theme + B-5 in the topbar).

Build the arrangement incrementally within Stage 2/6: static clips → drag/move → trim/split → zoom/snap → marquee.

---

## API resolutions & open questions

All `// VERIFY` items from specs `00`–`06` were resolved against the pinned `tracktion_engine` clone (`2877b621`). **Exact signatures + the file-based fallbacks taken (new-clip landing, `renderToFile`, peak-array waveforms, the latency delay-line) live in [`docs/ENGINE_API_NOTES.md`](docs/ENGINE_API_NOTES.md);** the runtime shape is summarized in [ARCHITECTURE.md](ARCHITECTURE.md) §3.

Design micro-questions settled by the shipped implementation: `MOSH_RENDERLAYER` is **clip-parented**; undo/redo and structural changes resync via **`snapshot_invalidated`** (not inverse-deltas); selection is **UI-local** (commands carry explicit target args — no mirrored backend selection). Still gated: anira `InferenceHandler` (RAVE/DDSP) — v0 ships the inline RT-safe MLP; SA3 carve-out paths are env-driven (`SA3_MLX_DIR`, `COLORRACK_DATA`, `MOSH_JUDGES_PY`).

---

## Standing policy

- **macOS / Apple Silicon (arm64) + MLX is canonical** — unified-memory zero-copy is the load-bearing neural advantage on the Mac.
- **PC port (Windows + NVIDIA/CUDA):** parallel target, one codebase — SA3 swaps MLX→PyTorch/CUDA behind the same adapter contract. Details live elsewhere on purpose: platform matrix in [ARCHITECTURE.md](ARCHITECTURE.md) §Platforms, the per-feature **decision record** in [docs/WINDOWS_PARITY.md](docs/WINDOWS_PARITY.md), and the build/run/verify/package runbook in [docs/WINDOWS_RUNBOOK.md](docs/WINDOWS_RUNBOOK.md).
- **Spine first:** MoshOps + snapshot/events is the highest-leverage early work — UI and both neural tiers are clients of it.
- **The swappability gate (Stage 2)** is non-negotiable: rebuild the React bundle, zero backend change.
- **FakeAdapter before SA3** (Stage 5) — prove orchestration with the stub.
- The **arrange view** is incremental, not a from-scratch native renderer (it's React over the `02` contract) — lower risk than the prior plan, but still stage it.
- Optional non-blocking adds once core works: prompt-concision rewriter (`05 §6`), judge-panel quality readout (`05 §7`), `StableAudioOpenSmallAdapter` bring-up rung (`05 §2`).
- Deferred (do **not** build): B-5/operator behavior + multiplayer/CRDT op-log; on-device SAO-Small + Medium→Small transfer; the **real** on-device LoRA-base training + vector layering (the trainer *scaffold* + fake backend already landed — [note](docs/worklog/2026-06-18-type-beat-lora-trainer-scaffold-landed-post-v0-2026-06-18.md)); timestep-scheduled steering; full Context-Drawers system; **MRT2 live generative-instrument lane** (more viable now we're Mac-only, but not core v0 — `07`); foleys/cello/Gin/JUMP (only if a later need appears).

---

## Gotchas that still bite

*The traps that have actually cost time more than once. Full post-mortems in the worklog.*

- **Worktree builds:** the proven dep-cache recipe is
  `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.
  Do **not** point these into the old `~/Documents/ClaudeMosh` tree.
  Nothing a build reads may live under `~/Documents` — iCloud evicts file *contents* while leaving
  plausible-looking stat sizes, which fails as bizarre cmake errors.
  ([dep-cache eviction](docs/worklog/2026-07-10-seeded-dep-cache-config-healed-icloud-evicted-the-cpm-cache.md))
- **Worktree UI step:** the Vite/esbuild step SIGKILLs in a fresh worktree. Symlink
  `ui/node_modules` to the main checkout's (verify the lockfiles match first).
- **e2e must use the isolated config** (`ui/playwright.isolated.config.ts`, port 5191) whenever
  another session's dev server owns `:5173` — a foreign bundle false-fails *every* spec.
  Same class: `preview_start` resolves `.claude/launch.json` from the *session's* cwd, so a dev
  server can silently serve a different worktree. Probe the served tree before believing a screenshot.
- **`--selftest` sessions:** headless runs auto-isolate, but an explicit `MOSH_SELFTEST_SESSION`
  wins **verbatim** — two runs sharing one leaf delete each other's artifacts mid-test.
  `commandLine.contains("--selftest")` is also true for `--selftest-undo`; match undo FIRST.
  ([SLF-CONC-001](docs/worklog/2026-07-18-slf-conc-001-selftest-made-hermetic-against-a-concurrent-sel.md))
- **JUCE ignores `$HOME`** — a harness run always hits the real `~/Library/Mosh`. There is no
  sandbox; isolate via `MOSH_SELFTEST_SESSION` or unit-test the pure helper instead.
- **Branch protection vs the loops:** `enforce_admins` is on, so **`gh pr merge --admin` cannot
  bypass a required check**; `merge-one.sh` waits for the check and merges without `--admin`.
  Don't reintroduce `--admin` — it will just fail.
  **Since 2026-07-24 the required `cheap gate` context is REMOVED** (GitHub Actions billing is
  dead — every check fails in 1–3s, which is the tell), so merges go through on the local gate.
  Verify with `gh api repos/zeke431/Mosh/branches/main/protection`; restore the context when
  billing recovers. A 1-second "failure" is an outage, not a red test — but read the durations
  before believing that.
- **Selftest check counts are environment-dependent.** A dev Mac with SA3/RAVE/whisper weights
  reports ~1681; hermetic CI reports 1656; a Release bundle without them reports fewer still.
  Never paste a locally-observed count into `MOSH_SELFTEST_BASELINE` — it reds every CI run.
- **Vacuous verification is this repo's recurring failure mode.** A test that cannot fail looks
  exactly like one that passes. RED-prove every new guard, count assertions, and check the fixture
  isn't stubbed. `grep SABOTAGE` before landing anything that involved a RED-proof.
  One worktree = one agent — #424 shipped `return 0; // SABOTAGE` stubs because two agents shared one.
  **A guard that SUPPRESSES something needs a fixture that actually carries it.** "Hidden pairs leak
  no artist name" passed a sabotage that deleted the hiding logic outright, because the fixture's
  hidden pair had no artist name to leak. Sabotage with an absolute path and verify the restore —
  a `cd x && cp backup` chain leaves the sabotage in the tree when the `cd` fails.
- **Never verify a native change with a pre-existing binary.** Build from committed source.
- **`--selftest` cannot see the reactive lane.** `reactiveTouch` returns on `!hasAudio() &&
  !MOSH_REACTIVE_DEBOUNCE_MS` **before** reading any state it gates on, so a headless run cannot
  tell a working reactive feature from a dead one. `freeze_layer` shipped as a label-only
  command from Stage 5, and outright wrong from the moment the reactive loop landed (Phase 3,
  2026-06-30) — the whole time with a passing selftest check asserting the label was written. Prove reactive behaviour in `verify.py` (live service, files counted on
  disk) — selftest can pin the flag, only verify.py proves the effect.
  **Run `verify.py` from the repo ROOT**: `GenerativeJobManager` resolves `service/server.py`
  CWD-relative, so running it from `scripts/verify-hardware/` fails every service-dependent check
  with "generative service unavailable" — including pre-existing ones, which reads as if your
  change broke nine things.
  ([UI-REACH close-out](docs/worklog/2026-07-26-ui-reach-closed-16-to-0-freeze-was-inert-bounce-had-no-surface.md))
- **A new MoshOps command needs FOUR registrations, not one.** Dispatch alone builds and passes
  `--selftest`; the drift guards live elsewhere. `test_multiplayer_lock_manager.cpp` (AL-011)
  fails if it has no lock scope — an unclassified command fails **closed** to `SessionGlobal`
  (guarded-until-classified; this line used to claim "unguarded", which the code at
  `LockManager.cpp:108` contradicts) — its golden ledger (`tests/golden/lock_scopes.tsv`,
  landing with #489) needs the command's row, and `commands.contract.test.ts` fails if it is in
  neither the agent catalog nor `commandClassification.ts`. All are Catch2/vitest, so a
  native-only gate run will miss them.
- **A written reason is a claim about the code, and it ages.** Nine of the sixteen `UI_REACH_GAPS`
  entries turned out to describe an assumption, not the tree — a "missing drag gesture" whose whole
  surface was absent, a "kit picker" with one kit and no enumeration, two commands that did nothing
  at all. Re-read the source before building what a stale reason asks for; the same applies to
  `UI_ONLY_COMMANDS` reasons and to the comments in this file.
- **`if (auto* p = someVarReturningFn().getArray())`** — the `juce::var` temporary dies at the end
  of the if-condition. Bind to a named local first. This has caused a real use-after-free.
- **Plugins created for `pluginList` must come from `edit.getPluginCache().createNewPlugin(...)`**,
  not `PluginManager::createNewPlugin`, or `indexOf` fails and it asserts.
- **A RAVE model can legitimately map out-of-domain input to exact silence.** Never validate a
  streaming model with a single block, and never let a harness bind to one blind-picked model.
  ([diagnosis](docs/worklog/2026-07-16-rave-rack-silent-under-pinned-libtorch-was-one-bad-model-not.md))
- **Over `ssh pc`** (PowerShell 5.1) stage `.ps1` files and run `pwsh -NoProfile -File` — nested
  `-Command` quoting corrupts silently. Python goldens need `PYTHONUTF8=1` on Windows.

---

## Working notes → [`docs/worklog/`](docs/worklog/INDEX.md)

Dated session notes live in **[`docs/worklog/`](docs/worklog/INDEX.md)** — INDEX.md is the table, and its count/links are guard-enforced (`ui/src/docs/worklogIndex.test.ts`) —
one file per note, moved verbatim. They were inlined here until they reached ~112 KB — about 28k
tokens of context spent before any work started.

**Grep that directory before assuming a problem is new.** Much of it is post-mortems whose lesson is
a trap that will bite again.
